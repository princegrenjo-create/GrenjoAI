import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import type { ChatContentPart, ChatTurn } from '@core/provider-contract';
import type { ChatMessage, Conversation, ModelDescriptor, ProviderConfig } from '@core/types';
import { AppError, appError, asAppError } from '@core/errors';
import { ATTACHMENT_LIMITS, formatBytes, type MessageAttachment } from '@core/attachments';
import { composeHistory, resolveParamsForTurn } from '@/ai/turn';
import { useApp } from '@/state/app';
import { appendMessage, getConversation, listMessages, setConversationModel, touchConversation, updateMessage } from '@/db/database';
import { pickDocuments, pickImage, recordingAttachment, toMessageAttachments, type IngestedAttachment } from '@/attachments/ingest';
import { buildUserContent, streamChat, transcribeAudio } from '@/ai/client';
import { Button, EmptyState, ErrorBanner, Muted } from '@/ui/components';
import { colors, radius, space, touchTarget, type as t } from '@/ui/theme';

/** One in-flight turn; the AbortController is what Stop aborts. */
interface ActiveTurn {
  controller: AbortController;
  assistantId: string;
  text: string;
}

export default function ChatScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const app = useApp();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<IngestedAttachment[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [turn, setTurn] = useState<ActiveTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  const load = useCallback(async () => {
    if (!app.db || !id) return;
    setConversation(await getConversation(app.db, id));
    setMessages(await listMessages(app.db, id));
  }, [app.db, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = useMemo<ModelDescriptor | null>(() => {
    if (!conversation) return null;
    return (
      app.models.find(
        (entry) => entry.providerId === conversation.providerId && entry.modelId === conversation.modelId,
      ) ??
      app.models[0] ??
      null
    );
  }, [app.models, conversation]);

  const provider = useMemo<ProviderConfig | null>(() => {
    if (!model) return null;
    return app.providers.find((entry) => entry.id === model.providerId) ?? null;
  }, [app.providers, model]);

  const images = attachments.filter((item) => item.meta.kind === 'image');
  const imageBlocked = images.length > 0 && model !== null && !model.capabilities.imageInput;

  const addIngested = (result: { attachments: IngestedAttachment[]; rejected: Array<{ name: string; reason: string }> }): void => {
    setAttachments((current) => {
      const room = ATTACHMENT_LIMITS.maxPerMessage - current.length;
      return [...current, ...result.attachments.slice(0, Math.max(0, room))];
    });
    setRejected(result.rejected.map((entry) => `${entry.name}: ${entry.reason}`));
  };

  const attachDocuments = async (): Promise<void> => {
    try {
      addIngested(await pickDocuments());
    } catch (cause) {
      setError(asAppError(cause).message);
    }
  };

  const attachImage = async (source: 'library' | 'camera'): Promise<void> => {
    try {
      addIngested(await pickImage(source));
    } catch (cause) {
      setError(asAppError(cause).message);
    }
  };

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      await recorder.stop();
      setRecording(false);
      return;
    }
    setError(null);
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError('Microphone access was not granted, so nothing was recorded. Enable it in Settings to transcribe a memo.');
      return;
    }
    try {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch (cause) {
      setError(`The microphone could not start: ${asAppError(cause).message}`);
    }
  };

  const attachRecording = async (): Promise<void> => {
    const uri = recorder.uri;
    if (!uri) {
      setError('There is no finished recording to attach.');
      return;
    }
    let sizeBytes: number | null = null;
    try {
      const response = await fetch(uri);
      const blob = await response.blob();
      sizeBytes = blob.size;
    } catch {
      sizeBytes = null;
    }
    setAttachments((current) => [
      ...current,
      recordingAttachment({ uri, durationMs: recorderState.durationMillis, mimeType: 'audio/mp4', sizeBytes }),
    ]);
  };

  const transcribeRecording = async (): Promise<void> => {
    const uri = recorder.uri;
    if (!uri || !provider || !model) {
      setError('Record something and select a provider first.');
      return;
    }
    const openai = app.providers.find((entry) => entry.kind === 'openai');
    if (!openai) {
      setError('Transcription needs an OpenAI API key. Add OpenAI under Models, paste your key, then record again.');
      return;
    }
    const apiKey = await app.keyFor(openai);
    if (!apiKey) {
      setError('Transcription needs an OpenAI API key. Add one under Models, then try again.');
      return;
    }
    setTranscribing(true);
    setError(null);
    try {
      const text = await transcribeAudio({
        target: { providerId: openai.id, kind: openai.kind, baseUrl: openai.baseUrl, apiKey, model },
        fileUri: uri,
        mimeType: 'audio/mp4',
        fileName: 'voice-memo.m4a',
      });
      // The transcript goes into the composer, it is not sent automatically.
      setDraft((current) => (current.trim().length > 0 ? `${current}\n${text}` : text));
      setRecording(false);
    } catch (cause) {
      setError(asAppError(cause).message);
    } finally {
      setTranscribing(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!app.db || !id || !model || !provider) {
      setError('Choose a model under Models before sending a message.');
      return;
    }
    const text = draft.trim();
    if (text.length === 0 && attachments.length === 0) return;
    if (imageBlocked) {
      setError(`${model.displayName} cannot read images. Choose a model that accepts image input, or remove the image.`);
      return;
    }

    setBusy(true);
    setError(null);
    const controller = new AbortController();
    try {
      const apiKey = await app.keyFor(provider);
      if (!apiKey) {
        throw new AppError(appError('missing_key', `No API key is stored for ${provider.name}. Add one under Models.`));
      }

      const documentText = composeHistory(text, attachments);
      const userMessage = await appendMessage(app.db, {
        conversationId: id,
        role: 'user',
        content: documentText,
        attachments: toMessageAttachments(attachments) as MessageAttachment[],
        modelRef: { providerId: provider.id, modelId: model.modelId },
      });
      const assistant = await appendMessage(app.db, {
        conversationId: id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        modelRef: { providerId: provider.id, modelId: model.modelId },
      });
      setMessages((current) => [...current, userMessage, assistant]);
      setDraft('');
      setAttachments([]);
      setRejected([]);

      const history = await listMessages(app.db, id);
      const agent = conversation?.agentId ? app.agents.find((entry) => entry.id === conversation.agentId) : null;
      const params = resolveParamsForTurn({
        model,
        appDefaults: app.settings.defaults.params,
        agentParams: agent?.params ?? null,
        conversationParams: conversation?.paramsOverride ?? null,
        weirdness: app.settings.weirdness,
      });

      const turns: ChatTurn[] = history
        .filter((message) => message.role !== 'system' && message.content.trim().length > 0)
        .filter((message) => message.status !== 'error')
        .slice(-Math.max(1, app.settings.generation.maxHistoryMessages))
        .map((message, index, all) => {
          const isLastUser = index === all.length - 1 && message.role === 'user';
          const content: string | ChatContentPart[] = isLastUser
            ? buildUserContent(
                message.content,
                images.map((item) => ({
                  mimeType: item.meta.mimeType,
                  dataBase64: item.image?.dataBase64 ?? '',
                })),
              )
            : message.content;
          return { role: message.role === 'assistant' ? 'assistant' : 'user', content };
        });

      const active: ActiveTurn = { controller, assistantId: assistant.id, text: '' };
      setTurn(active);

      const result = await streamChat({
        target: { providerId: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, apiKey, model },
        turns,
        system: agent?.systemPrompt ?? conversation?.systemPrompt ?? null,
        params,
        signal: controller.signal,
        timeoutMs: app.settings.generation.requestTimeoutMs,
        onText: (chunk) => {
          active.text += chunk;
          setMessages((current) =>
            current.map((message) =>
              message.id === assistant.id ? { ...message, content: active.text } : message,
            ),
          );
        },
      });

      const finalText = active.text.length > 0 ? active.text : result.text;
      if (finalText.trim().length === 0) {
        throw new AppError(appError('provider_error', 'The provider returned an empty response.'));
      }
      await updateMessage(app.db, assistant.id, { content: finalText, status: 'complete' });
      await touchConversation(app.db, id);
      await app.refreshConversations();
      await load();
    } catch (cause) {
      const shape = controller.signal.aborted
        ? appError('cancelled', 'Generation stopped.')
        : asAppError(cause);
      const stopped = controller.signal.aborted || shape.code === 'cancelled';
      if (turn?.assistantId) {
        await updateMessage(app.db, turn.assistantId, {
          status: stopped ? 'stopped' : 'error',
          error: stopped ? null : shape,
          content: turn.text,
        });
      }
      setError(shape.message);
      await load();
    } finally {
      setTurn(null);
      setBusy(false);
    }
  };

  const stop = (): void => {
    turn?.controller.abort();
  };

  const chooseModel = (): void => {
    if (!app.db || !id || app.models.length === 0) {
      setError('There are no models yet. Add a provider under Models first.');
      return;
    }
    Alert.alert(
      'Choose a model',
      'Only a model that accepts images can read the picture you attached.',
      app.models.slice(0, 6).map((entry) => ({
        text: `${entry.displayName}${entry.capabilities.imageInput ? ' (images)' : ''}`,
        onPress: async () => {
          await setConversationModel(app.db as NonNullable<typeof app.db>, id, entry.providerId, entry.modelId);
          await load();
        },
      })),
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <EmptyState
            title="Nothing here yet"
            detail={
              model
                ? `You are talking to ${model.displayName}. Messages stay on this device.`
                : 'Add a provider and a model under Models to start.'
            }
          />
        }
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}>
            <Text style={styles.bubbleMeta}>
              {item.role === 'user' ? 'You' : (model?.displayName ?? 'Assistant')}
              {item.status === 'error' ? ' · error' : item.status === 'stopped' ? ' · stopped' : ''}
            </Text>
            {item.content.length > 0 ? <Text style={styles.bubbleText}>{item.content}</Text> : null}
            {item.status === 'streaming' ? <Text style={styles.caret}>▍</Text> : null}
            {item.attachments.map((attachment) => (
              <View key={attachment.id} style={styles.chip}>
                <Text style={styles.chipText} numberOfLines={1}>
                  {attachment.name} · {formatBytes(attachment.sizeBytes)}
                  {attachment.contentStatus !== 'extracted' ? ' · contents not read' : ''}
                </Text>
              </View>
            ))}
            {item.error ? <Text style={styles.bubbleError}>{item.error.message}</Text> : null}
          </View>
        )}
      />

      {error ? <ErrorBanner message={error} /> : null}
      {rejected.map((reason) => (
        <Muted key={reason}>{reason}</Muted>
      ))}

      {attachments.length > 0 ? (
        <View style={styles.attachments}>
          {attachments.map((item) => (
            <Pressable
              key={item.meta.id}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.meta.name}`}
              onPress={() => setAttachments((current) => current.filter((entry) => entry.meta.id !== item.meta.id))}
              style={styles.chip}
            >
              <Text style={styles.chipText} numberOfLines={1}>
                {item.meta.name} · {formatBytes(item.meta.sizeBytes)}
                {item.meta.kind === 'image' ? ' · image' : ''}
                {item.meta.contentStatus !== 'extracted' ? ' · contents not read' : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {imageBlocked ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>
            {model?.displayName} can&apos;t accept images. Remove the image, or choose a model with image
            input. Text and document attachments are always allowed.
          </Text>
          <Button label="Choose a model" variant="secondary" onPress={chooseModel} />
        </View>
      ) : null}

      {recording ? (
        <View style={styles.recorder}>
          <Text style={styles.recorderTime}>
            Recording {formatDuration(recorderState.durationMillis)} · tap stop when you are done
          </Text>
          <View style={styles.row}>
            <Button label="Stop" variant="danger" onPress={() => void toggleRecording()} />
            <Button
              label="Transcribe"
              variant="secondary"
              loading={transcribing}
              onPress={() => void transcribeRecording()}
            />
            <Button label="Attach audio" variant="ghost" onPress={() => void attachRecording()} />
          </View>
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Message"
          placeholder={model ? 'Ask anything…' : 'Add a model first'}
          placeholderTextColor={colors.textSubtle}
          multiline
          value={draft}
          onChangeText={setDraft}
          style={styles.input}
          editable={!busy}
        />
        <View style={styles.actions}>
          <Button label="File" variant="ghost" onPress={() => void attachDocuments()} />
          <Button label="Image" variant="ghost" onPress={() => void attachImage('library')} />
          <Button label="Camera" variant="ghost" onPress={() => void attachImage('camera')} />
          <Button
            label={recording ? 'Recording…' : 'Voice'}
            variant="ghost"
            onPress={() => void toggleRecording()}
          />
          {turn ? (
            <Button label="Stop" variant="danger" onPress={stop} />
          ) : (
            <Button
              label="Send"
              onPress={() => void send()}
              disabled={busy || imageBlocked || (draft.trim().length === 0 && attachments.length === 0)}
            />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60).toString().padStart(2, '0');
  const seconds = (total % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  bubble: { borderRadius: radius.lg, padding: space.md, gap: space.xs, maxWidth: '92%' },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: colors.surface2 },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  bubbleMeta: { color: colors.textSubtle, fontSize: t.caption },
  bubbleText: { color: colors.text, fontSize: t.body, lineHeight: t.body * 1.5 },
  bubbleError: { color: colors.danger, fontSize: t.caption },
  caret: { color: colors.accent, fontSize: t.body },
  chip: {
    backgroundColor: colors.surface2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    minHeight: touchTarget - 12,
    justifyContent: 'center',
  },
  chipText: { color: colors.textMuted, fontSize: t.caption },
  attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, paddingHorizontal: space.lg },
  warning: {
    marginHorizontal: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
    gap: space.sm,
  },
  warningText: { color: colors.text, fontSize: t.label, lineHeight: t.label * 1.5 },
  recorder: {
    marginHorizontal: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    gap: space.sm,
  },
  recorderTime: { color: colors.text, fontSize: t.label },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.md,
    gap: space.sm,
  },
  input: {
    minHeight: touchTarget,
    maxHeight: 160,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: t.body,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
});

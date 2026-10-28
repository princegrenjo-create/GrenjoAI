import { useCallback, useState, type ReactNode } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useApp } from '@/state/app';
import { createConversation, listConversations } from '@/db/database';
import type { Conversation } from '@core/types';
import { Button, EmptyState, ErrorBanner, Muted } from '@/ui/components';
import { colors, radius, space, touchTarget, type as t } from '@/ui/theme';

export default function ConversationsScreen(): ReactNode {
  const app = useApp();
  const [items, setItems] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!app.db) return;
    try {
      setItems(await listConversations(app.db, search));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The conversation list could not be read.');
    }
  }, [app.db, search]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const start = async (): Promise<void> => {
    if (!app.db) return;
    const conversation = await createConversation(app.db, {
      providerId: app.settings.defaults.providerId ?? app.providers[0]?.id ?? null,
      modelId: app.settings.defaults.modelId ?? app.models[0]?.modelId ?? null,
    });
    router.push({ pathname: '/chat/[id]', params: { id: conversation.id } });
  };

  const remove = (conversation: Conversation): void => {
    Alert.alert('Delete conversation?', `"${conversation.title}" and its messages will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await app.removeConversation(conversation.id);
          await load();
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TextInput
          accessibilityLabel="Search conversations"
          placeholder="Search conversations"
          placeholderTextColor={colors.textSubtle}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={() => void load()}
          style={styles.search}
        />
        <Button label="New chat" onPress={() => void start()} />
      </View>

      {app.error ? <ErrorBanner message={app.error} /> : null}
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {app.providers.length === 0 ? (
        <Muted>
          Add a provider and an API key under Models before your first message. Nothing leaves this
          device until you send.
        </Muted>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState
            title="No conversations yet"
            detail="Start a chat and it will be stored on this phone only. There is no cloud sync in this release."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title}`}
            onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })}
            onLongPress={() => remove(item)}
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
          >
            <Text style={styles.itemTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.itemMeta}>
              {item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'} Â·{' '}
              {new Date(item.updatedAt).toLocaleString()}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: space.lg, gap: space.md, backgroundColor: colors.bg },
  header: { gap: space.sm },
  search: {
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: space.md,
    fontSize: t.body,
  },
  list: { gap: space.sm, paddingBottom: space.xxl },
  item: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: touchTarget,
    gap: space.xs,
  },
  itemPressed: { backgroundColor: colors.surface2 },
  itemTitle: { color: colors.text, fontSize: t.body, fontWeight: '600' },
  itemMeta: { color: colors.textMuted, fontSize: t.caption },
});

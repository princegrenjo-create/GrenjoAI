import { useCallback, useState, type ReactNode } from 'react';
import { Alert, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { Agent } from '@core/types';
import { useApp } from '@/state/app';
import { Button, EmptyState, Field, Muted, Section } from '@/ui/components';
import { colors, radius, space, type as t } from '@/ui/theme';

export default function AgentsScreen(): ReactNode {
  const app = useApp();
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => undefined, []));

  const reset = (): void => {
    setEditing(null);
    setName('');
    setDescription('');
    setSystemPrompt('');
  };

  const save = async (): Promise<void> => {
    if (name.trim().length === 0) {
      setError('An agent needs a name.');
      return;
    }
    if (systemPrompt.trim().length === 0) {
      setError('An agent needs a system prompt — that is what makes it a persona.');
      return;
    }
    const model = app.models[0];
    await app.saveAgent({
      id: editing?.id,
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      providerId: editing?.providerId ?? model?.providerId ?? null,
      modelId: editing?.modelId ?? model?.modelId ?? null,
      params: editing?.params ?? {},
    });
    setError(null);
    reset();
  };

  const startEditing = (agent: Agent): void => {
    setEditing(agent);
    setName(agent.name);
    setDescription(agent.description);
    setSystemPrompt(agent.systemPrompt);
  };

  const remove = (agent: Agent): void => {
    Alert.alert('Delete agent?', `"${agent.name}" will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await app.removeAgent(agent.id);
          if (editing?.id === agent.id) reset();
        },
      },
    ]);
  };

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={app.agents}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View style={styles.form}>
          <Section title={editing ? `Edit ${editing.name}` : 'New agent'}>
            <Field label="Name" value={name} onChangeText={setName} placeholder="Terse editor" />
            <Field
              label="Description"
              value={description}
              onChangeText={setDescription}
              placeholder="What this agent is for"
            />
            <Field
              label="System prompt"
              value={systemPrompt}
              onChangeText={setSystemPrompt}
              placeholder="You are a terse editor…"
              multiline
              numberOfLines={4}
              style={styles.prompt}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.row}>
              <Button label={editing ? 'Save agent' : 'Create agent'} onPress={() => void save()} />
              {editing ? <Button label="Cancel" variant="ghost" onPress={reset} /> : null}
            </View>
            <Muted>
              Agents use their system prompt and the app defaults on this device. Per-agent parameter
              overrides stay on the desktop build in this release.
            </Muted>
          </Section>
        </View>
      }
      ListEmptyComponent={
        <EmptyState title="No agents yet" detail="An agent is a saved persona: a name and a system prompt." />
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          {item.description.length > 0 ? <Muted>{item.description}</Muted> : null}
          <Text style={styles.promptPreview} numberOfLines={3}>
            {item.systemPrompt}
          </Text>
          <View style={styles.row}>
            <Button label="Edit" variant="secondary" onPress={() => startEditing(item)} />
            <Button label="Delete" variant="danger" onPress={() => remove(item)} />
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  form: { gap: space.md, marginBottom: space.md },
  prompt: { minHeight: 96, textAlignVertical: 'top' },
  promptPreview: { color: colors.textMuted, fontSize: t.caption, fontStyle: 'italic' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  cardTitle: { color: colors.text, fontSize: t.body, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  error: { color: colors.danger, fontSize: t.caption },
});

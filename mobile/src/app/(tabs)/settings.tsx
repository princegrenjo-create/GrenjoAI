import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useApp } from '@/state/app';
import { Button, Card, Muted, Section } from '@/ui/components';
import { colors, space, type as t } from '@/ui/theme';

export default function SettingsScreen(): ReactNode {
  const app = useApp();
  const [message, setMessage] = useState<string | null>(null);

  const streaming = app.settings.chat.streaming;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Section title="Chat">
        <Card>
          <Text style={styles.label}>Stream replies</Text>
          <Muted>
            Streaming is on by default: tokens appear as the provider sends them. Turning it off is not
            available on mobile yet — the streaming path is the only one implemented here.
          </Muted>
          <Button
            label={streaming ? 'Streaming: on' : 'Streaming: off'}
            variant="secondary"
            onPress={() => setMessage('Streaming stays on in this mobile release.')}
          />
        </Card>
      </Section>

      <Section title="Generation">
        <Card>
          <Text style={styles.label}>Request timeout</Text>
          <Muted>{Math.round(app.settings.generation.requestTimeoutMs / 1000)} seconds</Muted>
          <Text style={styles.label}>Retries</Text>
          <Muted>{app.settings.generation.maxRetries} for temporary failures</Muted>
          <Text style={styles.label}>History replayed</Text>
          <Muted>{app.settings.generation.maxHistoryMessages} messages</Muted>
          <Muted>Editing these on mobile lands in the next release; the desktop app can change them today.</Muted>
        </Card>
      </Section>

      <Section title="Where your data lives">
        <Card>
          <Muted>
            Chats, agents, custom models and settings are stored in a SQLite database inside this app&apos;s
            private sandbox. API keys live in the iOS Keychain or the Android Keystore, never in that
            database.
          </Muted>
          <Muted>
            There is no cloud sync in this release, so nothing on this phone is uploaded except the text,
            images and audio you explicitly send to a provider you configured.
          </Muted>
          {message ? <Text style={styles.note}>{message}</Text> : null}
        </Card>
      </Section>

      <Section title="About">
        <Card>
          <Text style={styles.label}>Grenjo AI Tool</Text>
          <Muted>Version {Constants.expoConfig?.version ?? '0.1.0'}</Muted>
          <Muted>Expo SDK {Constants.expoConfig?.sdkVersion ?? 'unknown'}</Muted>
        </Card>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 },
  label: { color: colors.text, fontSize: t.label, fontWeight: '600' },
  note: { color: colors.accent, fontSize: t.caption },
});

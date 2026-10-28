import { useState, type ReactNode } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ProviderKind } from '@core/types';
import { PROVIDER_PRESETS, PROVIDER_ORDER, MODEL_HINTS_AS_OF } from '@core/defaults';
import { formatBytes } from '@core/attachments';
import { useApp } from '@/state/app';
import { Button, Card, EmptyState, ErrorBanner, Field, Muted, Section } from '@/ui/components';
import { colors, radius, space, type as t } from '@/ui/theme';

export default function ModelsScreen(): ReactNode {
  const app = useApp();
  const [kind, setKind] = useState<ProviderKind>('deepseek');
  const [name, setName] = useState(PROVIDER_PRESETS.deepseek.defaultName);
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS.deepseek.defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fingerprints, setFingerprints] = useState<Record<string, string | null>>({});
  const [customModelId, setCustomModelId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customImage, setCustomImage] = useState(false);

  const chooseKind = (next: ProviderKind): void => {
    setKind(next);
    setName(PROVIDER_PRESETS[next].defaultName);
    setBaseUrl(PROVIDER_PRESETS[next].defaultBaseUrl);
  };

  const addProvider = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await app.addProvider({ kind, name, baseUrl, apiKey });
      setApiKey('');
      await app.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The provider could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const discover = async (providerId: string): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const count = await app.discoverModels(providerId);
      Alert.alert('Discovery finished', `${count} model${count === 1 ? '' : 's'} found.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Discovery failed.');
    } finally {
      setBusy(false);
    }
  };

  const showFingerprint = async (providerId: string): Promise<void> => {
    const provider = app.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    const print = await app.keyFingerprint(provider);
    setFingerprints((current) => ({ ...current, [providerId]: print }));
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Section title="Add a provider">
        <View style={styles.kindRow}>
          {PROVIDER_ORDER.map((entry) => (
            <Button
              key={entry}
              label={PROVIDER_PRESETS[entry].label}
              variant={entry === kind ? 'primary' : 'secondary'}
              onPress={() => chooseKind(entry)}
            />
          ))}
        </View>
        <Field label="Name" value={name} onChangeText={setName} />
        <Field
          label="Base URL"
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          hint="HTTPS only. A plain-HTTP remote host is refused."
        />
        <Field
          label="API key"
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          hint="Stored in the iOS Keychain / Android Keystore. Never written to the database."
        />
        {error ? <ErrorBanner message={error} /> : null}
        <Button label="Save provider" onPress={() => void addProvider()} loading={busy} disabled={apiKey.trim().length === 0} />
      </Section>

      <Section title="Providers">
        {app.providers.length === 0 ? (
          <EmptyState title="No providers yet" detail="Bring your own key. Nothing is shared with another device." />
        ) : null}
        {app.providers.map((provider) => (
          <Card key={provider.id}>
            <Text style={styles.cardTitle}>{provider.name}</Text>
            <Muted>
              {provider.kind} Â· {provider.baseUrl}
            </Muted>
            <Muted>
              {fingerprints[provider.id]
                ? `Key stored (${fingerprints[provider.id]})`
                : 'Tap "Key status" to check the stored credential.'}
            </Muted>
            <View style={styles.row}>
              <Button label="Key status" variant="secondary" onPress={() => void showFingerprint(provider.id)} />
              <Button label="Discover" variant="secondary" onPress={() => void discover(provider.id)} />
              <Button
                label="Remove"
                variant="danger"
                onPress={() =>
                  Alert.alert('Remove provider?', `${provider.name} and its stored key will be removed from this device.`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => void app.removeProvider(provider.id) },
                  ])
                }
              />
            </View>
          </Card>
        ))}
      </Section>

      <Section title="Others / Custom Models">
        <Muted>
          The built-in list is a hint list as of {MODEL_HINTS_AS_OF}. Discovery is authoritative; add a
          model by hand when discovery does not return it.
        </Muted>
        <Field label="Exact model id" value={customModelId} onChangeText={setCustomModelId} autoCapitalize="none" />
        <Field label="Display name" value={customName} onChangeText={setCustomName} />
        <Button
          label={customImage ? 'Image input: yes' : 'Image input: no'}
          variant="secondary"
          onPress={() => setCustomImage((current) => !current)}
        />
        <Button
          label="Add custom model"
          onPress={() =>
            void app
              .addCustomModel({
                providerId: app.providers[0]?.id ?? '',
                modelId: customModelId,
                displayName: customName,
                imageInput: customImage,
              })
              .then(() => {
                setCustomModelId('');
                setCustomName('');
              })
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : 'The model could not be saved.'),
              )
          }
          disabled={customModelId.trim().length === 0 || app.providers.length === 0}
        />
      </Section>

      <Section title="Models">
        {app.models.map((model) => (
          <Card key={model.id}>
            <Text style={styles.cardTitle}>{model.displayName}</Text>
            <Muted>
              {model.modelId} Â· {model.source}
            </Muted>
            <Muted>
              {model.capabilities.imageInput ? 'images' : 'no image input'} Â·{' '}
              {model.limits.contextWindow
                ? `${formatBytes(model.limits.contextWindow * 4)} context`
                : 'limits unknown'}
            </Muted>
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cardTitle: { color: colors.text, fontSize: t.body, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
});

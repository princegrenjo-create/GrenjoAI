/**
 * Shared UI primitives for mobile.
 *
 * Every value comes from `src/ui/theme.ts`; there are no inline magic numbers in
 * the screens. Each interactive element carries a 44pt minimum target and a
 * pressed state, and every list surface has an empty and an error state because
 * the screens are useless without them.
 */
import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { colors, radius, space, touchTarget, type } from './theme';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
}): ReactNode {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        variant === 'danger' && styles.buttonDanger,
        pressed && !isDisabled && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.accentContrast : colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === 'primary' && styles.buttonLabelPrimary,
            variant === 'danger' && styles.buttonLabelDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  ...inputProps
}: TextInputProps & { label: string; hint?: string; error?: string }): ReactNode {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={colors.textSubtle}
        style={[styles.input, error ? styles.inputError : null]}
        {...inputProps}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      {!error && hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }): ReactNode {
  return <View style={styles.card}>{children}</View>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }): ReactNode {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDetail}>{detail}</Text>
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{message}</Text>
      {onRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function Row({ children }: { children: ReactNode }): ReactNode {
  return <View style={styles.row}>{children}</View>;
}

export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Screen({ children }: { children: ReactNode }): ReactNode {
  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

export function Muted({ children }: { children: ReactNode }): ReactNode {
  return <Text style={styles.muted}>{children}</Text>;
}

export const styles = StyleSheet.create({
  screen: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 },
  section: { gap: space.sm },
  sectionTitle: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: '600',
    marginBottom: space.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  muted: { color: colors.textMuted, fontSize: type.label, lineHeight: type.label * 1.5 },
  button: {
    minHeight: touchTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surface2, borderColor: colors.border },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDanger: { backgroundColor: 'transparent', borderColor: colors.danger },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { color: colors.text, fontSize: type.body, fontWeight: '500' },
  buttonLabelPrimary: { color: colors.accentContrast },
  buttonLabelDanger: { color: colors.danger },
  field: { gap: space.xs },
  fieldLabel: { color: colors.textMuted, fontSize: type.label, fontWeight: '500' },
  input: {
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: type.body,
  },
  inputError: { borderColor: colors.danger },
  fieldHint: { color: colors.textSubtle, fontSize: type.caption },
  fieldError: { color: colors.danger, fontSize: type.caption },
  empty: { paddingVertical: space.xxl, gap: space.sm, alignItems: 'center' },
  emptyTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
  emptyDetail: {
    color: colors.textMuted,
    fontSize: type.label,
    textAlign: 'center',
    lineHeight: type.label * 1.5,
  },
  banner: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  bannerText: { color: colors.text, fontSize: type.label, lineHeight: type.label * 1.5 },
});

/**
 * Formatting helpers. All of them tolerate an invalid or missing timestamp and
 * never throw into a render path.
 */

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const FULL = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Clock time for a message, e.g. "14:05"; empty when the value is unusable. */
export function formatTime(iso: string | null | undefined): string {
  const date = toDate(iso);
  return date ? TIME.format(date) : '';
}

/** Timestamp for a tooltip, e.g. "29 Oct 2026, 14:05". */
export function formatFullTimestamp(iso: string | null | undefined): string {
  const date = toDate(iso);
  return date ? FULL.format(date) : '';
}

/**
 * Conversation list meta: time for today, short date otherwise. A list that
 * repeats "29 Oct 2026" on every row is noise; a relative label is not.
 */
export function formatConversationStamp(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  const date = toDate(iso);
  if (!date) return '';
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? TIME.format(date) : DAY.format(date);
}

export function formatCount(value: number, singular: string, plural?: string): string {
  const label = value === 1 ? singular : (plural ?? `${singular}s`);
  return `${value.toLocaleString()} ${label}`;
}

export function formatTokenUsage(total: number): string {
  if (total >= 1000) {
    const thousands = total / 1000;
    return `${thousands.toFixed(thousands >= 10 ? 0 : 1)}k tokens`;
  }
  return `${total} tokens`;
}

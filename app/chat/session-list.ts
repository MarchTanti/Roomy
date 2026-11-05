/**
 * The shape of the conversation list.
 *
 * The sidebar shows the same list on every screen, so the wording of it —
 * "วันนี้", "เมื่อวาน", a date — is decided here, where it can be tested,
 * rather than in the component that draws it.
 */

/** One conversation, as `/api/history` gives it. */
export interface HistoryItem {
  id: string;
  created_at: string;
  title: string;
  message_count: number;
  image_quota_left?: number;
}

/** Midnight of the day the date falls in, in the reader's own timezone. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** How many days apart two dates are, counting calendar days. */
function daysApart(then: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

/**
 * When a conversation happened, the way a person would say it.
 *
 * Today and yesterday are named; anything older gets its date. The clock is
 * only shown for the two recent days, because "12 ก.ค. 2569 14:30" is a
 * mouthful for a list.
 */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const days = daysApart(then, now);
  if (days === 0) return `วันนี้ ${clockTime(then)}`;
  if (days === 1) return `เมื่อวาน ${clockTime(then)}`;
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' }).format(then);
}

/** "14:30" — the clock, as a 24-hour one. */
function clockTime(date: Date): string {
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * A title on one line.
 *
 * The title is the first thing the person said, which can be a whole
 * paragraph. The list is a narrow column, so the title is cut rather than
 * wrapped — and a cut title keeps its ellipsis where the eye expects it.
 */
export function shortTitle(title: string, max = 46): string {
  const trimmed = title.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The label of one conversation in the list.
 *
 * The date and the number of messages are the two facts that help someone
 * pick the right one, so they travel together.
 */
export function listLabel(item: HistoryItem, now: Date = new Date()): string {
  const count = item.message_count;
  const messages = count === 1 ? '1 ข้อความ' : `${count} ข้อความ`;
  return `${relativeWhen(item.created_at, now)} · ${messages}`;
}

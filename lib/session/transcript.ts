/**
 * Reading a stored conversation back.
 *
 * The `messages` table holds what the model was sent and what it said, in the
 * `LlmMessage` shape. Replaying that as a chat transcript needs two things
 * the raw rows do not give: the tool round trips have to be hidden (they are
 * plumbing, not conversation), and the model turns have to be labelled as the
 * assistant's.
 *
 * A row that does not parse is skipped rather than allowed to break the page:
 * one bad row should cost one line, not the whole history.
 */

import type { Json, Message } from '@/lib/db/types';
import type { DesignView } from '@/lib/design/view';
import { extractDesign } from '@/lib/design/tool';
import { isLlmMessage, type LlmMessage } from '@/lib/llm/history';
import { extractSearchProducts, type SearchProduct } from '@/lib/llm/tools';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  /** When the turn was said. */
  created_at: string;
  /**
   * The products the answer was about.
   *
   * They are recovered from the tool results the model got, so a reopened
   * conversation still shows the pictures of what was recommended. The
   * renderer only puts a picture next to a product the text actually names.
   */
  products?: SearchProduct[];
  /**
   * The room the assistant designed, when it designed one.
   *
   * Recovered the same way as the products: the picture and the pieces of the
   * room are in the tool result the model got, so a reopened conversation
   * still shows the room that was drawn.
   */
  design?: DesignView;
}

/** The text of one stored message, or '' when it holds none. */
export function messageText(content: Json | unknown): string {
  if (!isLlmMessage(content)) return '';
  return content.parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** The stored conversation, as the chat shows it. */
export function toTranscript(messages: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // The messages as the model saw them, so the tool results are available.
  const history: LlmMessage[] = [];

  for (const message of messages) {
    if (isLlmMessage(message.content)) history.push(message.content);

    const text = messageText(message.content);
    if (!text) continue;

    if (message.role === 'assistant') {
      entries.push({
        role: 'assistant',
        text,
        created_at: message.created_at,
        products: extractSearchProducts(history),
        design: extractDesign(history)?.view,
      });
    } else {
      entries.push({ role: 'user', text, created_at: message.created_at });
    }
  }

  return entries;
}

/**
 * What to call this conversation.
 *
 * The first thing the person said, cut short. When there is no message yet
 * the session was just created, so the time is all there is to say.
 */
export function transcriptTitle(messages: readonly Message[], fallback = ''): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = messageText(message.content);
    if (!text) continue;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 70 ? `${oneLine.slice(0, 70)}…` : oneLine;
  }
  return fallback;
}

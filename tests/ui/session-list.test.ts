import { describe, expect, it } from 'vitest';

import { listLabel, relativeWhen, shortTitle } from '@/app/chat/session-list';

/**
 * The wording of the conversation list.
 *
 * The list is how someone finds the conversation they had yesterday, so
 * "today" and "yesterday" have to be right — and they have to be right in
 * the reader's own timezone, not the server's.
 */

const NOW = new Date('2026-10-31T12:00:00+07:00');

describe('relativeWhen', () => {
  it('names today', () => {
    expect(relativeWhen('2026-10-31T09:05:00+07:00', NOW)).toBe('วันนี้ 09:05');
  });

  it('names yesterday', () => {
    expect(relativeWhen('2026-10-30T21:40:00+07:00', NOW)).toBe('เมื่อวาน 21:40');
  });

  it('gives a date for anything older', () => {
    const when = relativeWhen('2026-07-12T14:30:00+07:00', NOW);
    expect(when).toBe('12 ก.ค. 2569');
    expect(when).not.toContain(':');
  });

  it('counts days by the calendar, not by the hour', () => {
    // 23:30 yesterday is thirty minutes ago, but it is still yesterday.
    const late = new Date('2026-10-30T23:30:00+07:00');
    expect(relativeWhen(late.toISOString(), new Date('2026-10-31T00:15:00+07:00'))).toBe(
      'เมื่อวาน 23:30',
    );
  });

  it('says nothing about a date it cannot read', () => {
    expect(relativeWhen('not a date', NOW)).toBe('');
  });
});

describe('shortTitle', () => {
  it('leaves a short title alone', () => {
    expect(shortTitle('ห้องนั่งเล่น 3×4 เมตร')).toBe('ห้องนั่งเล่น 3×4 เมตร');
  });

  it('cuts a long one and says so', () => {
    const cut = shortTitle('a'.repeat(80));
    expect(cut).toHaveLength(46);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('trims the space before the ellipsis', () => {
    const cut = shortTitle('word '.repeat(12));
    expect(cut).toBe(`${'word '.repeat(9).trimEnd()}…`);
    expect(cut).not.toContain(' …');
  });
});

describe('listLabel', () => {
  it('puts the date and the number of messages together', () => {
    expect(
      listLabel(
        {
          id: 'a',
          created_at: '2026-10-31T09:05:00+07:00',
          title: 'ห้องนั่งเล่น',
          message_count: 4,
        },
        NOW,
      ),
    ).toBe('วันนี้ 09:05 · 4 ข้อความ');
  });

  it('says one message in the singular', () => {
    expect(
      listLabel(
        {
          id: 'a',
          created_at: '2026-10-31T09:05:00+07:00',
          title: 'ห้องนั่งเล่น',
          message_count: 1,
        },
        NOW,
      ),
    ).toBe('วันนี้ 09:05 · 1 ข้อความ');
  });
});

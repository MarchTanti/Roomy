import { describe, expect, it } from 'vitest';

import { imageKey, isValidImageKey, parseImageKey } from '@/lib/storage/keys';

const SESSION = '11111111-2222-3333-4444-555555555555';
const IMAGE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('storage keys', () => {
  it('imageKey assembles "<sessionId>/<imageId>.jpg"', () => {
    expect(imageKey(SESSION, IMAGE)).toBe(`${SESSION}/${IMAGE}.jpg`);
  });

  it('imageKey rejects non-UUID inputs', () => {
    expect(() => imageKey('not-a-uuid', IMAGE)).toThrow(/sessionId is not a UUID/);
    expect(() => imageKey(SESSION, 'not-a-uuid')).toThrow(/imageId is not a UUID/);
  });

  it('parseImageKey round-trips with imageKey', () => {
    const path = imageKey(SESSION, IMAGE);
    const parsed = parseImageKey(path);
    expect(parsed).toEqual({ sessionId: SESSION, imageId: IMAGE, extension: 'jpg' });
  });

  it('parseImageKey rejects malformed paths', () => {
    expect(() => parseImageKey('nope')).toThrow();
    expect(() => parseImageKey(`folder/${IMAGE}`)).toThrow(/missing extension/);
    // `IMAGE` looks UUID-shaped, so it parses as the folder; the file stem is
    // "foo", which is not a UUID.
    expect(() => parseImageKey(`${IMAGE}/foo.jpg`)).toThrow(/imageId is not a UUID/);
    expect(() => parseImageKey(`not-a-uuid/${IMAGE}.jpg`)).toThrow(/sessionId is not a UUID/);
    expect(() => parseImageKey(`${SESSION}/no-dots`)).toThrow(/missing extension/);
  });

  it('isValidImageKey accepts valid paths and rejects the rest', () => {
    expect(isValidImageKey(imageKey(SESSION, IMAGE))).toBe(true);
    expect(isValidImageKey('random/text')).toBe(false);
    expect(isValidImageKey('')).toBe(false);
  });
});

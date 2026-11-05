/**
 * The rule that decides which theme is in effect.
 *
 * The same rule runs in two places: here, in the browser, and in the tiny
 * script the document carries so the right palette is on screen before the
 * first paint. The script cannot import anything, so it is a copy — and this
 * test runs that copy, rather than trusting that it stayed a copy.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isTheme,
  oppositeTheme,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
} from '@/lib/theme';

describe('resolveTheme', () => {
  it('uses the stored choice when there is one', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('falls back to the system when nothing is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });

  it('does not trust a value it does not know', () => {
    expect(resolveTheme('purple', true)).toBe('dark');
    expect(resolveTheme('purple', false)).toBe('light');
    expect(resolveTheme('', true)).toBe('dark');
    expect(resolveTheme('DARK', true)).toBe('dark');
  });
});

describe('isTheme', () => {
  it('knows the two themes and nothing else', () => {
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('Light')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });
});

describe('oppositeTheme', () => {
  it('swaps', () => {
    expect(oppositeTheme('light')).toBe('dark');
    expect(oppositeTheme('dark')).toBe('light');
  });
});

describe('the script the document carries', () => {
  /** The script as the layout builds it. */
  async function loadScript(): Promise<string> {
    const source = await readFile(path.join(process.cwd(), 'app', 'layout.tsx'), 'utf8');
    const match = /const THEME_SCRIPT = `([^`]*)`/.exec(source);
    if (!match) throw new Error('THEME_SCRIPT is not in app/layout.tsx');

    // The template literal holds two interpolations; the script that runs in
    // the browser has them filled in.
    return match[1]
      .replace('${THEME_STORAGE_KEY}', THEME_STORAGE_KEY)
      .replace('${THEME_ATTRIBUTE}', THEME_ATTRIBUTE);
  }

  /** Runs the script against a browser that only knows what it needs to. */
  function runScript(script: string, stored: string | null, prefersDark: boolean): string | null {
    const attributes = new Map<string, string>();
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
        getAttribute: (name: string) => attributes.get(name) ?? null,
      },
      querySelector: () => null,
    };
    const localStorage = {
      getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null),
      setItem: () => {},
    };
    const window = {
      matchMedia: (query: string) => ({ matches: prefersDark && query.includes('dark') }),
    };

    // eslint-disable-next-line no-new-func
    new Function('document', 'localStorage', 'window', script)(document, localStorage, window);
    return attributes.get(THEME_ATTRIBUTE) ?? null;
  }

  it('applies the stored choice', async () => {
    const script = await loadScript();
    expect(runScript(script, 'dark', false)).toBe('dark');
    expect(runScript(script, 'light', true)).toBe('light');
  });

  it('follows the system when nothing is stored', async () => {
    const script = await loadScript();
    expect(runScript(script, null, true)).toBe('dark');
    expect(runScript(script, null, false)).toBe('light');
  });

  it('agrees with resolveTheme, whatever it is given', async () => {
    const script = await loadScript();
    for (const stored of [null, 'dark', 'light', 'purple', '']) {
      for (const prefersDark of [true, false]) {
        expect(runScript(script, stored, prefersDark)).toBe(
          resolveTheme(stored, prefersDark),
        );
      }
    }
  });

  it('survives a browser that will not let it read the storage', async () => {
    const script = await loadScript();
    const attributes = new Map<string, string>();
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
        getAttribute: (name: string) => attributes.get(name) ?? null,
      },
      querySelector: () => null,
    };
    const localStorage = {
      getItem: () => {
        throw new Error('storage is blocked');
      },
      setItem: () => {},
    };
    const window = { matchMedia: () => ({ matches: false }) };

    // eslint-disable-next-line no-new-func
    expect(
      () =>
        new Function('document', 'localStorage', 'window', script)(
          document,
          localStorage,
          window,
        ),
    ).not.toThrow();

    // The page is still rendered in the light theme, which is the server's
    // default — the same thing that happens with no JavaScript at all.
    expect(attributes.has(THEME_ATTRIBUTE)).toBe(false);
  });
});

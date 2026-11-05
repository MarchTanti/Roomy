/**
 * The theme, and where the choice lives.
 *
 * Two things decide what the screen looks like: the choice the person made
 * (kept in `localStorage`) and the operating system's own preference. A stored
 * choice wins. Without one, the system decides — and the same rule runs again
 * on the next page, so the app looks the same wherever it is opened.
 *
 * The palette itself is CSS: every colour is a `light-dark()` pair, so a token
 * holds both of its versions and the browser picks one. This file is only
 * about *which* one is in effect.
 *
 * The little script in the document applies the same rule before the first
 * paint; it cannot import anything, so it is a copy of `resolveTheme` below.
 * The two have to agree, and the test pins that copy's shape.
 */

export type Theme = 'light' | 'dark';

/** Where the choice is kept, in the browser. */
export const THEME_STORAGE_KEY = 'roomy.theme';

/** The attribute on `<html>` that the palette and the icons read. */
export const THEME_ATTRIBUTE = 'data-theme';

/** Whether a value is a theme we know. */
export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/**
 * The theme in effect: the stored choice if there is one, the system's
 * preference otherwise.
 *
 * Anything that is not a theme we know — a half-written value, a key from an
 * older version of the app — is treated as "no choice", rather than trusted.
 */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (isTheme(stored)) return stored;
  return prefersDark ? 'dark' : 'light';
}

/** The theme the button switches to. */
export function oppositeTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

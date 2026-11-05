'use client';

/**
 * The theme switch.
 *
 * A button with two icons in it — a sun and a moon — and CSS decides which
 * one is showing, from the same `data-theme` attribute the palette reads.
 * That keeps the button out of React's state entirely: there is no
 * server-rendered icon that could disagree with the browser, so there is no
 * hydration warning and no flash of the wrong symbol.
 *
 * The icon shows the theme you would switch **to** — a moon in the light
 * theme, a sun in the dark one — which is the convention people already know
 * from other apps.
 *
 * The choice is kept in `localStorage`. The script in the document applies it
 * before the first paint; this button only changes it afterwards.
 */

import { useEffect, useLayoutEffect } from 'react';

import {
  isTheme,
  oppositeTheme,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type Theme,
} from '@/lib/theme';

/**
 * `useLayoutEffect` before the paint, `useEffect` on the server.
 *
 * The server has no layout phase to run in, and React says so out loud if a
 * layout effect is used there. This is the usual way around it.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The stored choice, or null when there is none (or storage is blocked). */
function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** What the operating system wants. */
function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The theme in effect right now, as the page sees it. */
function currentTheme(): Theme {
  const attribute = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  if (isTheme(attribute)) return attribute;
  return resolveTheme(readStored(), prefersDark());
}

/** Turns the theme on, and remembers the choice. */
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A browser that refuses to store the choice still gets the theme — it
    // just will not survive a reload.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  // React's development remount resets `<html>`'s attributes to the ones it
  // manages from JSX, which drops the theme the inline script set. Put it
  // back. This does nothing in production.
  useBeforePaint(() => {
    document.documentElement.setAttribute(
      THEME_ATTRIBUTE,
      resolveTheme(readStored(), prefersDark()),
    );
  }, []);

  return (
    <button
      type="button"
      onClick={() => applyTheme(oppositeTheme(currentTheme()))}
      className={
        className ?? 'btn-band grid size-9 shrink-0 place-items-center rounded-full'
      }
      aria-label="สลับธีมสว่างและมืด"
      title="สลับธีมสว่าง/มืด"
    >
      {/* The moon: shown in the light theme. */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="theme-icon-moon size-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>

      {/* The sun: shown in the dark theme. */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="theme-icon-sun size-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
    </button>
  );
}

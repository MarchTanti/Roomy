import type { Metadata, Viewport } from 'next';
import { Noto_Sans_Thai, Noto_Serif_Thai } from 'next/font/google';

import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from '@/lib/theme';

import { InlineScript } from './inline-script';
import './globals.css';

/*
 * The fonts are self-hosted by Next: the browser never asks Google for them,
 * and the pages look the same on a machine with no Thai font installed — which
 * is most of the machines this is developed on.
 */
const sans = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  variable: '--font-noto-sans-thai',
  display: 'swap',
});

const display = Noto_Serif_Thai({
  subsets: ['thai', 'latin'],
  variable: '--font-noto-serif-thai',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'RoomyAI — ผู้ช่วยจัดวางเฟอร์นิเจอร์ลงในห้องของคุณ',
    template: '%s · RoomyAI',
  },
  description:
    'อัปโหลดรูปห้อง แล้วให้ RoomyAI ดูสไตล์ วัดพื้นที่ แนะนำเฟอร์นิเจอร์ที่วางได้จริง และวาดลงในรูปห้องของคุณ',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The colour of the browser's own bar. It starts as the light canvas and
  // the script below corrects it when the theme is not the light one.
  themeColor: '#ebf3fa',
};

/*
 * The theme, applied before the first paint.
 *
 * The server cannot know what the person chose — the choice lives in their
 * browser — so the document is rendered in the light theme, and this script,
 * which runs while the browser parses the page, puts the right one on screen
 * before anything is shown. Without it, a person who chose the dark theme
 * would get a white flash on every load.
 *
 * It is a copy of `resolveTheme` in `lib/theme.ts`, because a script in the
 * document cannot import anything. The two hexes at the end are the canvas
 * colours — the same two the palette uses for `--surface`.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('${THEME_ATTRIBUTE}',d?'dark':'light');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',d?'#14213a':'#ebf3fa')}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Thai is the default UI language per the spec.
    //
    // `data-theme` is what the palette reads, and the script below corrects
    // it before the first paint; `suppressHydrationWarning` tells React to
    // keep the DOM as the browser found it rather than insist on its own
    // version of the attribute.
    <html
      lang="th"
      data-theme="light"
      suppressHydrationWarning
      className={`${sans.variable} ${display.variable}`}
    >
      <body className="min-h-dvh bg-surface font-sans text-ink antialiased">
        <InlineScript html={THEME_SCRIPT} />
        {children}
      </body>
    </html>
  );
}

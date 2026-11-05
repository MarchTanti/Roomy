import Image from 'next/image';
import Link from 'next/link';

/**
 * The way home, carrying the mark.
 *
 * Every page opens with the same blue band, and the way back to the landing
 * page is the logo itself: the mark and the name in a pill, so it reads as
 * the way home rather than as a picture in the corner. It is the same file
 * the rest of the brand uses — one mark, one place to change it.
 */
export function HomeButton({
  tone = 'band',
  label = 'RoomyAI',
  priority = true,
  iconSize = 22,
}: {
  /** `band` for the blue header band, `surface` for the canvas, `rail` for the left rail. */
  tone?: 'band' | 'surface' | 'rail';
  /** The words beside the mark. */
  label?: string;
  /** Only the marks on the first screen want to be fetched first. */
  priority?: boolean;
  /** The edge of the mark, in pixels. */
  iconSize?: number;
}) {
  const mark = (
    <Image
      src="/roomyai-icon.png"
      alt=""
      width={iconSize}
      height={iconSize}
      className="shrink-0"
      style={{ width: iconSize, height: iconSize }}
      priority={priority}
    />
  );

  return (
    <Link
      href="/"
      aria-label="RoomyAI — หน้าแรก"
      className={
        tone === 'band'
          ? 'btn-band inline-flex items-center gap-2 rounded-full px-2 py-1.5'
          : tone === 'surface'
            ? 'btn-quiet inline-flex items-center gap-2 rounded-full px-3 py-2'
            : // In the rail the mark sits on the rail's own ground, so it needs
              // neither a tile nor a pill: it is the way home, and it says so.
              'inline-flex items-center gap-2.5 transition-opacity hover:opacity-75'
      }
    >
      {/* On the blue band the mark needs something under it: the blue of the
          mark and the blue of the band are too close to tell apart. A small
          white tile carries it, and the button stays quiet enough not to
          compete with the one action that matters. */}
      {tone === 'band' ? (
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white">{mark}</span>
      ) : (
        mark
      )}
      <span className="font-display font-semibold tracking-tight">{label}</span>
    </Link>
  );
}

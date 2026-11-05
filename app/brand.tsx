import Image from 'next/image';

/**
 * The mark and the name.
 *
 * The picture of the logo is a blue rounded square with a white drawing
 * of a room and a sofa in it — the same blue as the buttons. On the blue band
 * of the header it is the one thing that carries the brand, so the name next
 * to it is set in the page's own type — the name has to be selectable, and it
 * has to be readable in both themes, which the wordmark in the picture is not.
 *
 * The mark is decorative here: the name beside it says what it is.
 */
export function Brand({
  className,
  iconSize = 32,
  nameClass = 'text-lg font-semibold tracking-tight',
  priority = true,
}: {
  className?: string;
  /** The edge of the mark, in pixels. */
  iconSize?: number;
  /** The type of the name beside it. */
  nameClass?: string;
  /** Only the marks that are on the first screen want to be fetched first. */
  priority?: boolean;
}) {
  return (
    <span className={`flex items-center gap-2 ${className ?? ''}`}>
      <Image
        src="/roomyai-icon.png"
        alt=""
        width={iconSize}
        height={iconSize}
        className="shrink-0"
        style={{ width: iconSize, height: iconSize }}
        priority={priority}
      />
      <span className={`font-display ${nameClass}`}>RoomyAI</span>
    </span>
  );
}

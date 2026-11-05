/**
 * An inline script, run by the browser while it parses the page.
 *
 * React warns in development when it renders a `<script>` tag, because the
 * script has already run by the time the client takes over. The type is
 * switched to `text/plain` on the client so the browser ignores it there —
 * and `suppressHydrationWarning` covers the difference between the two.
 *
 * This is the pattern Next's own guide for "preventing flash before
 * hydration" uses.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

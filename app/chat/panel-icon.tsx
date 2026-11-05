/**
 * The rail: a panel with a divider down the side, the way a sidebar is drawn.
 *
 * It lives in its own file because both ends of the rail need it — the button
 * in the rail's header closes the rail, and the button that stands in for the
 * rail when it is closed opens it.
 */
export function PanelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="size-4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

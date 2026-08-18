// Ported from the original app's icon('bolt') SVG path — the brand mark.
export function BoltIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="brand-bolt"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  );
}

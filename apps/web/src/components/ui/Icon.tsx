const PATHS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5',
  checkCircle: 'm8.5 12.5 2.5 2.5 4.5-5|circle:12,12,9',
  camera:
    'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z|circle:12,13,3.5',
  x: 'M18 6 6 18|M6 6l12 12',
  back: 'm15 18-6-6 6-6',
  forward: 'm9 18 6-6-6-6',
  calendar: 'M3 10h18|M8 3v4|M16 3v4|rect:3,5,18,16,2',
  trash:
    'M3 6h18|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6|M10 11v6|M14 11v6',
  plus: 'M12 5v14|M5 12h14',
  wrench:
    'M14.7 6.3a4 4 0 0 1 5.3 4.6l-1.8-1.8-2.1.5-.5 2.1 1.8 1.8a4 4 0 0 1-4.6-5.3L4.8 17.3a1.8 1.8 0 1 0 2.5 2.5l8.4-8.4',
  search: 'm20 20-3.5-3.5|circle:11,11,7',
};

export function Icon({ name, size = 15 }: { name: keyof typeof PATHS; size?: number }) {
  const spec = PATHS[name] || '';
  const parts = spec.split('|').filter(Boolean);
  return (
    <svg
      className="ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-3px' }}
    >
      {parts.map((p, i) => {
        if (p.startsWith('circle:')) {
          const [cx, cy, r] = p.slice(7).split(',').map(Number);
          return <circle key={i} cx={cx} cy={cy} r={r} />;
        }
        if (p.startsWith('rect:')) {
          const [x, y, w, h, rx] = p.slice(5).split(',').map(Number);
          return <rect key={i} x={x} y={y} width={w} height={h} rx={rx} />;
        }
        return <path key={i} d={p} />;
      })}
    </svg>
  );
}

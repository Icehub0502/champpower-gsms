import type { LineWarranty } from '@gsms/contracts/index.js';

/** The customer / car box at the top of every sheet. Label-value pairs, two per row on A4. */
export function PartyBlock({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="pr-party">
      {rows.map(([k, v]) => (
        <div key={k} className="pr-party-item">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "แร็ค 1 ปี · 365 วัน / 20,000 กม." from the line's snapshot; null when there is none. */
export function warrantyText(w: LineWarranty | null): string | null {
  if (!w) return null;
  const limits = [
    w.days !== null ? `${w.days.toLocaleString('en-US')} วัน` : null,
    w.maxKm !== null ? `${w.maxKm.toLocaleString('en-US')} กม.` : null,
  ].filter(Boolean).join(' / ');
  return limits ? `${w.name} · ${limits}` : w.name;
}

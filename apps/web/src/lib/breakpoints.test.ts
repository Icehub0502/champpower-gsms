/**
 * Keeps the breakpoints in one place. globals.css cannot read custom
 * properties inside a media query, so the widths are written literally there;
 * this test fails if a width query appears that is neither one of
 * BREAKPOINTS nor a known pre-existing ad hoc query on an unrelated page.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS } from './breakpoints';

const css = readFileSync(fileURLToPath(new URL('../styles/globals.css', import.meta.url)), 'utf8')
  // Ignore the documentation block at the top of the file.
  .replace(/\/\*[\s\S]*?\*\//g, '');

const canonical = new Set<string>(
  Object.values(BREAKPOINTS).flatMap((px) => [`min-width: ${px}px`, `max-width: ${px - 0.02}px`]),
);

// Pre-existing queries on pages outside the shell. Listed so they cannot
// multiply; each goes away when its page is ported onto the tiers.
const LEGACY = new Map<string, string>([
  ['max-width: 700px', 'job list grid + dashboard widgets (JobListPage)'],
  ['max-width: 900px', 'login split screen (LoginPage)'],
]);

describe('globals.css width breakpoints', () => {
  it('uses only the canonical tiers (plus allow-listed legacy page queries)', () => {
    const found = [...css.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)].map(
      (m) => `${m[1]}-width: ${m[2]}px`,
    );
    expect(found.length).toBeGreaterThan(0);
    const stray = found.filter((q) => !canonical.has(q) && !LEGACY.has(q));
    expect(stray).toEqual([]);
  });

  it('touch sizing is tied to pointer: coarse, not to a width', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*min-height: var\(--touch-min\)/);
  });
});

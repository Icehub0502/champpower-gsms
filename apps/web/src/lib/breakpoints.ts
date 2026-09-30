/**
 * The layout breakpoints, mirrored from the "BREAKPOINTS" block at the top of
 * styles/globals.css. CSS custom properties cannot be used inside a media
 * query, so the numbers necessarily exist twice — here and in that block —
 * and `breakpoints.test.ts` fails if the stylesheet grows a width query that
 * is not one of these.
 *
 * Read this before reaching for these values in JS: the shell deliberately
 * does NOT branch its component tree on width (docs/UI-SPEC-FIGMA.md §4 rule
 * 2 — rotating an iPad 820 -> 1180 must not remount a half-filled form). If a
 * screen needs width in JS, use it to change a value or a class, never which
 * component renders or what `key` it has.
 */
export const BREAKPOINTS = {
  /** 768–1023: iPad portrait / iPad mini — icon rail, kanban shows 2 columns */
  tablet: 768,
  /** 1024–1279: iPad landscape (1180) — icon rail, kanban shows all 4 */
  tabletWide: 1024,
  /** ≥1280: desktop / iPad Pro landscape — full 232px sidebar */
  desktop: 1280,
  /** ≥1600: public /board only — TV in the waiting room, read from 3–4 m */
  tv: 1600,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

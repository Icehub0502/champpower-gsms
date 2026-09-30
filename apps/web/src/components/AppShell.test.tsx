// @vitest-environment happy-dom
/**
 * Rotation / resize must not remount anything inside the shell
 * (docs/UI-SPEC-FIGMA.md §4 rule 2). An iPad turning 820 -> 1180 crosses the
 * 1024 breakpoint; if AppShell branched its tree on width, a half-filled form
 * inside it would be thrown away every time staff turned the tablet.
 *
 * Method: mount the real AppShell with a controlled <input> as its child, type
 * into it, then walk the viewport across every tier (and back). After each
 * step the input must be the SAME DOM node, hold the typed value, and its
 * component must have mounted exactly once. The whole shell's DOM must also
 * be byte-identical at every width — i.e. only CSS changes the layout.
 *
 * The last test runs the same harness against a deliberately bad shell that
 * keys its content on a media query, and asserts the harness DOES see the
 * remount — so a pass above means something, not that the harness is blind.
 */
import { act, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { BREAKPOINTS } from '../lib/breakpoints';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Both sides of every boundary, a real device at each tier (390 iPhone,
// 820 iPad portrait, 1180 iPad landscape, 1440 Figma frame), then back down —
// a rotation is a round trip.
const WIDTHS = [
  390,
  BREAKPOINTS.tablet - 1, BREAKPOINTS.tablet, 820,
  BREAKPOINTS.tabletWide - 1, BREAKPOINTS.tabletWide, 1180,
  BREAKPOINTS.desktop - 1, BREAKPOINTS.desktop, 1440,
  BREAKPOINTS.tv - 1, BREAKPOINTS.tv, 1920,
  1180, 820, 1180, 820, 390,
];

const TYPED = 'กข 1234 ลูกหมากหน้าซ้ายมีเสียง';

let mounts = 0;

function DraftForm() {
  const [value, setValue] = useState('');
  useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <input
      data-testid="draft"
      aria-label="draft"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

function setViewport(width: number) {
  const w = window as unknown as {
    happyDOM?: { setViewport(v: { width: number; height: number }): void };
  };
  const height = width < BREAKPOINTS.tablet ? 844 : 900;
  if (w.happyDOM?.setViewport) {
    w.happyDOM.setViewport({ width, height });
  } else {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    window.dispatchEvent(new Event('resize'));
  }
}

function typeInto(input: HTMLInputElement, text: string) {
  // React tracks the last value it rendered; going through the native setter
  // is what makes the following `input` event register as a real change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const user = { id: '00000000-0000-4000-8000-000000000001', loginId: 'ice', name: 'Ice' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mounts = 0;
  setViewport(390);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderInShell(shell: (children: ReactNode) => ReactNode) {
  act(() => {
    root.render(<MemoryRouter initialEntries={['/today']}>{shell(<DraftForm />)}</MemoryRouter>);
  });
  return container.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
}

describe('AppShell survives resize/rotation without remounting', () => {
  it('the viewport helper really changes width (so media-query listeners would fire)', () => {
    setViewport(390);
    expect(window.innerWidth).toBe(390);
    expect(window.matchMedia(`(min-width: ${BREAKPOINTS.tablet}px)`).matches).toBe(false);
    setViewport(1180);
    expect(window.innerWidth).toBe(1180);
    expect(window.matchMedia(`(min-width: ${BREAKPOINTS.tabletWide}px)`).matches).toBe(true);
    expect(window.matchMedia(`(min-width: ${BREAKPOINTS.desktop}px)`).matches).toBe(false);
  });

  it('keeps the same input node, its typed value, and a single mount across every tier', () => {
    const input = renderInShell((children) => (
      <AppShell user={user} role="advisor" online onLogout={() => {}}>
        {children}
      </AppShell>
    ));
    act(() => typeInto(input, TYPED));
    expect(input.value).toBe(TYPED);
    expect(mounts).toBe(1);

    const htmlAt390 = container.innerHTML;

    for (const width of WIDTHS) {
      act(() => setViewport(width));
      const now = container.querySelector<HTMLInputElement>('[data-testid="draft"]');
      expect(now, `input missing at ${width}px`).toBe(input);
      expect(now!.value, `value lost at ${width}px`).toBe(TYPED);
      expect(mounts, `remounted at ${width}px`).toBe(1);
      // One tree for every width: layout differences are CSS only.
      expect(container.innerHTML, `DOM differs at ${width}px`).toBe(htmlAt390);
    }
  });

  it('renders the sidebar and the dock at every width (CSS decides which is visible)', () => {
    renderInShell((children) => (
      <AppShell user={user} role="advisor" online onLogout={() => {}}>
        {children}
      </AppShell>
    ));
    for (const width of [390, 820, 1180, 1440]) {
      act(() => setViewport(width));
      expect(container.querySelector('aside.sidebar')).not.toBeNull();
      expect(container.querySelector('nav.dock')).not.toBeNull();
    }
    // Only this week's screens are linked — nothing that renders NotYetAvailable.
    // No /board link: it now needs a per-shop token nobody in this app can
    // look up yet (see the comment in AppShell.tsx's sidebar-nav).
    const hrefs = [...container.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
    expect(new Set(hrefs)).toEqual(new Set(['/today', '/checkin']));
  });

  it('control: a shell that keys its content on a media query IS caught remounting', () => {
    const query = `(min-width: ${BREAKPOINTS.tabletWide}px)`;
    function useWide() {
      return useSyncExternalStore(
        (cb) => {
          const mql = window.matchMedia(query);
          mql.addEventListener('change', cb);
          window.addEventListener('resize', cb);
          return () => {
            mql.removeEventListener('change', cb);
            window.removeEventListener('resize', cb);
          };
        },
        () => window.matchMedia(query).matches,
      );
    }
    function BadShell({ children }: { children: ReactNode }) {
      const wide = useWide();
      return <div key={wide ? 'wide' : 'narrow'}>{children}</div>;
    }

    setViewport(820);
    const input = renderInShell((children) => <BadShell>{children}</BadShell>);
    act(() => typeInto(input, TYPED));
    expect(mounts).toBe(1);

    act(() => setViewport(1180)); // iPad portrait -> landscape
    const after = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
    expect(mounts).toBe(2);
    expect(after).not.toBe(input);
    expect(after.value).toBe('');
  });
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts on purpose: vitest 2 (shared with
// packages/domain and apps/api) runs on the repo-root vite 5, while
// vite.config.ts loads @vitejs/plugin-react v6, which needs vite 8. Tests only
// need JSX compiled, which esbuild's automatic runtime does without the plugin.

// `@champpower/domain`'s package.json points `main` at `./dist/index.js`, and
// nothing in `npm test -w apps/web` rebuilds that dist first. A reviewer
// proved the consequence directly against apps/api's copy of this same
// problem: revert a rule in packages/domain/src, leave dist stale, run the
// suite — green, because every test exercising domain logic was importing the
// OLD compiled code. The `/today` screen imports `@champpower/domain` in six
// files, so apps/web has exactly the same exposure apps/api did. `fileURLToPath`
// rather than `.pathname` on the resolved URL: on Windows the latter yields
// `/C:/...`, which is not a path Node accepts.
//
// `vite.config.ts` carries the identical alias now, for the same reason applied
// to `vite dev` / `vite build` — see its comment. packages/domain/package.json
// itself is still untouched on purpose (a wider, cross-package decision that is
// not this app's to make alone); both this file and vite.config.ts route around
// its stale `dist` locally instead.
const domainSrc = fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@champpower/domain': domainSrc },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});

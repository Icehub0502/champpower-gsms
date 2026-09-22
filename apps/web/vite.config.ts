import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API's real port. `.env` at the repo root says PORT=3000, and that is
// what this proxy — and now everything else in this repo — treats as
// authoritative. apps/web/.env.example previously said 4000 while the root
// .env said 3000, and nothing enforced either; 3000 wins because that is what
// the API actually listens on (apps/api/src/index.ts reads PORT from the same
// root .env), and apps/web/.env.example has been corrected to match rather
// than the other way round.
const API_TARGET = 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Lets Vite's dev server accept requests through an ngrok tunnel (or any
    // other host) instead of only localhost — needed for temporary
    // cross-branch testing. Local-only dev config, not used in production.
    allowedHosts: true,
    proxy: {
      // Same-origin, on purpose — this is not a convenience, it is what makes
      // the refresh-token cookie work AT ALL in dev.
      //
      // The refresh cookie (apps/api/src/routes/auth.ts) is set with
      // SameSite=Strict — settled in docs/ARCHITECTURE.md §7 and confirmed by
      // the user over the weaker `Lax` that an earlier work-order draft had
      // written down; do not loosen it to make some other setup convenient.
      // A Strict cookie is withheld by the browser on ANY cross-site request,
      // and "cross-site" is judged by registrable domain, not by
      // localhost-vs-localhost port number: `http://localhost:5173` (this
      // dev server) calling `https://something.ngrok-free.app` (the old
      // apps/web/.env.local) is cross-site, full stop, so the cookie set on
      // login would simply never be sent back on /api/auth/refresh — refresh
      // would look "implemented" and silently never work outside this proxy.
      //
      // Routing '/api' and the socket path through Vite's own dev server
      // instead makes the browser see ONE origin (http://localhost:5173) for
      // both the app and its API calls, same-site by construction, and
      // removes the need for CORS in development entirely (the api-side CORS
      // middleware in apps/api/src/app.ts is still real and still required
      // for any deployment where the API is not reverse-proxied onto the same
      // origin as the web app — this proxy only covers `npm run dev`).
      //
      // If a future deploy puts the API on a different registrable domain
      // (an ngrok tunnel, a separate subdomain with no reverse proxy in
      // front), that deploy is incompatible with the SameSite=Strict
      // decision — fix the topology (a reverse proxy putting both under one
      // origin) rather than "fixing" a broken tunnel by loosening the cookie
      // to Lax or None.
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
      '/health': { target: API_TARGET, changeOrigin: true },
    },
  },
})

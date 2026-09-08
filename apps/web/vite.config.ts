import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Lets Vite's dev server accept requests through an ngrok tunnel (or any
    // other host) instead of only localhost — needed for temporary
    // cross-branch testing. Local-only dev config, not used in production.
    allowedHosts: true,
  },
})

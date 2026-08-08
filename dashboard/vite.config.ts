import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built and served as static files from the same Express app the API runs
// in (src/http/app.ts mounts it at /dashboard) — base has to match that
// mount path or the built asset URLs resolve wrong.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    // `npm run dev` here talks to a real backend (docker compose up / npm
    // start on 8080) instead of needing CORS or a duplicated API layer —
    // same-origin in production, proxied in dev.
    proxy: {
      '/logs': 'http://localhost:8080',
      '/admin': 'http://localhost:8080',
    },
  },
})

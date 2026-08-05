import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// In this reference repo the client's page (the hosted generic agent / "AI Playground") is built as
// a self-contained static bundle into `client/dist`, which the Eleventy site then passthrough-copies
// to `/agent` on hydrai.org. `how-it-works.html` is a hand-edited, self-contained page; it lives in
// `client/public/` so Vite copies it into the bundle verbatim.
const outDir = fileURLToPath(new URL('./dist', import.meta.url))

export default defineConfig({
  // Relative, because the bundle is mounted at a subpath (`/agent/`) as static files, not at the
  // origin root. The default `/` emits `/assets/…` references that 404 under that subpath. `./`
  // resolves every asset and every dynamic chunk (Comunica is one) against the page's own URL, so the
  // build works wherever it is mounted and does not hard-code the mount point.
  base: './',
  build: {
    outDir,
    // `dist` is a build artifact (git-ignored), so a clean rebuild each time is correct here — unlike
    // the in-tree build this was forked from, nothing hand-edited shares the directory.
    emptyOutDir: true,
    assetsDir: 'assets',
    // Off deliberately: the maps are the bulk of the output and buy little, since the TypeScript they
    // map back to is checked in beside the page. `npm run dev` serves full sourcemaps for debugging.
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})

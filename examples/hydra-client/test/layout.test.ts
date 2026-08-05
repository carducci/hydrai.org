import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import viteConfig from '../vite.config'

/**
 * Build layout.
 *
 * In the HydrAI monorepo this package is published by copying its `dist/` — and only `dist/` — to
 * `/agent` on hydrai.org. Two properties of that build are load-bearing and would be easy to undo in
 * a later "tidy up" without noticing, so they are asserted rather than documented:
 *
 *   1. The bundle is emitted into `dist/`, never into `src/` or the package root — so sources and
 *      `node_modules` are never swept into the published output (the same defect class as an
 *      anonymously web-reachable `node_modules`).
 *   2. `how-it-works.html` is a hand-edited, self-contained page kept in `public/`, so Vite always
 *      copies it into the bundle even though `emptyOutDir` is true.
 */

const clientRoot = fileURLToPath(new URL('..', import.meta.url))

describe('build layout', () => {
  it('emits the bundle into dist/, isolated from sources', () => {
    const build = (viteConfig as { build?: { outDir?: string } }).build
    expect(resolve(build?.outDir ?? '')).toBe(join(clientRoot, 'dist'))
  })

  it('resolves assets relative to the mount point, so it works under /agent/', () => {
    const base = (viteConfig as { base?: string }).base
    expect(base, "base must be './' so the bundle works mounted at a subpath").toBe('./')
  })

  it('keeps the hand-edited how-it-works.html in public/ so a clean build cannot lose it', () => {
    // emptyOutDir is true here, so anything that must survive the rebuild has to be a build input.
    const howItWorks = join(clientRoot, 'public', 'how-it-works.html')
    expect(existsSync(howItWorks), `expected ${howItWorks} to exist`).toBe(true)
  })
})

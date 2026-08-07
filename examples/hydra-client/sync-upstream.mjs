// Keep this vendored client in sync with its upstream (the MagoTech monorepo), in one command.
//
//   node sync-upstream.mjs --check     report drift without changing anything (exit 1 if drift)
//   node sync-upstream.mjs             apply: copy pristine files, protect the adaptations,
//                                      reconcile dependencies
//
// The upstream path comes from the HYDRA_UPSTREAM env var (or --upstream=PATH), so no personal
// absolute path lives in this public repo. See UPSTREAM.md for the full story and the durable options.
//
// The model: the whole upstream tree is pristine EXCEPT a declared set of files this repo owns (the
// adaptations). Pristine files are mirrored; adaptations are never touched; package.json has only its
// dependencies reconciled (name/scripts stay ours). Line endings are normalized to LF so git's
// normalization never shows up as false drift.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOWN = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const upstreamArg = args.find((a) => a.startsWith('--upstream='))?.split('=')[1]
const UP = upstreamArg || process.env.HYDRA_UPSTREAM

if (!UP) {
  console.error(
    'Set the upstream path first, e.g.\n' +
      '  HYDRA_UPSTREAM=/mnt/c/Mago/MagoTech/MagoTech/src/Web/HydraClient node sync-upstream.mjs --check\n' +
      'or pass --upstream=PATH. It is the MagoTech HydraClient directory on `master`.',
  )
  process.exit(2)
}
if (!existsSync(UP)) {
  console.error(`Upstream path does not exist: ${UP}`)
  process.exit(2)
}

// Files this repo owns — never overwritten by a sync. See UPSTREAM.md's adaptation table.
const ADAPTATIONS = new Set([
  'index.html', // HydrAI branding + domain-neutral demo copy
  'vite.config.ts', // dist output, base './'
  'src/ui/connection-form.ts', // empty defaultEntrypoint (no same-origin API on hydrai.org)
  'test/layout.test.ts', // asserts the dist/ contract
  'package.json', // deps reconciled below; name/scripts stay ours
  'package-lock.json', // workspace: the lockfile lives at the repo root, not here
  'README.md',
  'UPSTREAM.md',
  'sync-upstream.mjs',
])
// Directories that exist only downstream (never mirrored, never reported as orphans).
const DOWN_ONLY_DIRS = ['public', 'dist']
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git'])

const toPosix = (p) => p.split(sep).join('/')
const normalize = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n')
const isDownOnly = (rel) => DOWN_ONLY_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))

function walk(root) {
  const out = []
  const rec = (dir) => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDE_DIRS.has(name)) continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) rec(abs)
      else out.push(toPosix(relative(root, abs)))
    }
  }
  rec(root)
  return out
}

const upFiles = walk(UP)
const downFiles = new Set(walk(DOWN))

const updated = [] // pristine files that differ (or are new upstream)
const orphaned = [] // pristine files downstream that upstream no longer has

// ── Pristine file mirror ─────────────────────────────────────────────────────────────────────────
for (const rel of upFiles) {
  if (ADAPTATIONS.has(rel) || isDownOnly(rel)) continue
  const upText = normalize(readFileSync(join(UP, rel)))
  const downPath = join(DOWN, rel)
  const downText = existsSync(downPath) ? normalize(readFileSync(downPath)) : null
  if (downText === upText) continue
  updated.push(rel)
  if (!CHECK) {
    mkdirSync(dirname(downPath), { recursive: true })
    writeFileSync(downPath, upText, 'utf8')
  }
}

// Pristine files that exist here but not upstream (deleted upstream?) — reported, never auto-deleted.
for (const rel of downFiles) {
  if (ADAPTATIONS.has(rel) || isDownOnly(rel)) continue
  if (!existsSync(join(UP, rel))) orphaned.push(rel)
}

// ── Dependency reconcile (package.json) ──────────────────────────────────────────────────────────
const depChanges = []
{
  const upPkg = JSON.parse(readFileSync(join(UP, 'package.json'), 'utf8'))
  const downPkgPath = join(DOWN, 'package.json')
  const downPkg = JSON.parse(readFileSync(downPkgPath, 'utf8'))
  let changed = false
  for (const field of ['dependencies', 'devDependencies']) {
    const u = upPkg[field] ?? {}
    const d = downPkg[field] ?? {}
    const keys = [...new Set([...Object.keys(u), ...Object.keys(d)])].sort()
    for (const k of keys) {
      if (u[k] !== d[k]) depChanges.push(`${field}: ${k} ${d[k] ?? '(absent)'} -> ${u[k] ?? '(removed)'}`)
    }
    if (JSON.stringify(u) !== JSON.stringify(Object.fromEntries(Object.entries(d)))) {
      // Reconcile: adopt upstream's dep set exactly (sorted), keep everything else ours.
      const merged = {}
      for (const k of Object.keys(u).sort()) merged[k] = u[k]
      if (JSON.stringify(merged) !== JSON.stringify(d)) {
        downPkg[field] = merged
        changed = true
      }
    }
  }
  if (changed && !CHECK) writeFileSync(downPkgPath, JSON.stringify(downPkg, null, 2) + '\n', 'utf8')
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────
const drift = updated.length + orphaned.length + depChanges.length
const label = CHECK ? 'would change' : 'changed'
console.log(`\nUpstream: ${UP}`)
if (updated.length) console.log(`\nPristine files ${label} (${updated.length}):\n  ${updated.join('\n  ')}`)
if (orphaned.length) console.log(`\nDownstream-only pristine files (deleted upstream?) — review by hand (${orphaned.length}):\n  ${orphaned.join('\n  ')}`)
if (depChanges.length) console.log(`\nDependency changes ${label} (${depChanges.length}):\n  ${depChanges.join('\n  ')}`)

if (drift === 0) {
  console.log('\n✓ In sync with upstream. Adaptations preserved.\n')
  process.exit(0)
}
if (CHECK) {
  console.log('\n✗ Drift detected. Run `npm run sync` to apply, then `npm install && npm run build && npm test`.\n')
  process.exit(1)
}
console.log('\nApplied. Next: `npm install && npm run build && npm test`, review the diff, then commit.\n')

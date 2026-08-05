# Keeping this client in sync with its upstream

The generic Hydra client in this repository is a **vendored copy** of the reference implementation
that is developed inside the private MagoTech monorepo, where it is proven against a real production
Hydra API before it is published here.

- **Upstream (source of truth):** `MagoTech/src/Web/HydraClient` on the `master` branch.
- **Downstream (this public repo):** `examples/hydra-client/`.

Downstream carries a small, stable set of repo-specific adaptations — nothing else diverges:

| File | Adaptation | Why |
| --- | --- | --- |
| `vite.config.ts` | outputs to `./dist`, `emptyOutDir: true`, `base: './'` | published to `/agent` on hydrai.org, not into a .NET web app |
| `index.html` | HydrAI branding | this is the hosted public demo |
| `public/how-it-works.html` | present here | was a hand-edited sibling of the old build dir |
| `package.json` | name/scripts unchanged; dependencies mirror upstream | workspace member; root lockfile governs |
| `test/layout.test.ts` | asserts the `dist/` contract instead of the old `AIPlayground` one | the build target changed |
| `README.md`, this file | monorepo-oriented | public context |

## The drift risk, and why it's real

Upstream evolves — the last sync brought in a Markdown-rendering feature that also added two runtime
dependencies (`marked`, `dompurify`) and a dev dependency (`jsdom`). **Dependencies drift, not just
source.** A sync that only copies `src/` will miss `package.json` changes and produce a build that
fails to install or typecheck. The re-sync procedure below always reconciles `package.json`.

## Re-sync procedure (upstream → here)

Run from the repo root. `$UP` is the upstream client directory.

```bash
UP="/path/to/MagoTech/src/Web/HydraClient"
DN="examples/hydra-client"

# 1. Overwrite the pristine directories (everything except the adapted files).
for d in src mcp tools test; do cp -rf "$UP/$d/." "$DN/$d/"; done

# 2. Re-apply the two in-tree adaptations that live inside those dirs / at root.
#    - test/layout.test.ts  (keep THIS repo's version — asserts the dist/ contract)
#    - index.html           (keep HydrAI branding)
git checkout -- "$DN/test/layout.test.ts" "$DN/index.html"

# 3. Reconcile dependencies: diff upstream package.json against ours and copy any
#    added/removed deps or devDeps across. Do NOT copy scripts or name.
diff <(sed -n '/"dependencies"/,/}/p' "$UP/package.json") \
     <(sed -n '/"dependencies"/,/}/p' "$DN/package.json")

# 4. Reinstall + verify.
npm install
npm run build:agent
npm test --workspace hydra-client
```

The suite is the acceptance gate: if it is green after a sync, the copy is faithful. CI
(`.github/workflows/ci.yml`) runs it on every push, so a bad sync fails the PR.

## The durable options (pick one when this gets painful)

Copy-and-reconcile is fine at the current cadence. When it stops being fine, in rough order of effort:

1. **git subtree** — track `MagoTech/src/Web/HydraClient` as a subtree under `examples/hydra-client`
   and `git subtree pull` to bring updates in as real merges. Keeps history; needs the adaptations to
   live as commits on top (or as a tiny patch series) so a pull doesn't clobber them. Best fit if the
   two repos stay separate.
2. **Extract the client to its own package** — publish the runtime from MagoTech as a versioned npm
   package (e.g. `@hydrai/client`); this repo and MagoTech both depend on it, and the adaptations
   become build config, not forked files. The cleanest end state; the most up-front work.
3. **Make this repo the source of truth** — invert the relationship: develop the client here (public,
   with the full test suite and CI already in place) and vendor it *into* MagoTech. Attractive because
   the reference implementation *should* be the public one — but only once it can be exercised against
   a live Hydra API from here.

Recommendation: stay on copy-and-reconcile until the next sync feels tedious, then do (1) git subtree
as the low-friction upgrade. Revisit (2)/(3) if HydrAI attracts outside contributors, since both make
external contribution to the client far easier.

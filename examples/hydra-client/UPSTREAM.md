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
| `index.html` | HydrAI branding + domain-neutral demo copy | this is the hosted public demo, not the Mago-embedded one |
| `src/ui/connection-form.ts` | `defaultEntrypoint` returns `''` (was `window.location.origin + '/Api/'`) | hydrai.org has no same-origin API; the standalone demo is "bring your own API" |
| `public/how-it-works.html` | present here | was a hand-edited sibling of the old build dir |
| `package.json` | name/scripts unchanged; dependencies mirror upstream | workspace member; root lockfile governs |
| `test/layout.test.ts` | asserts the `dist/` contract instead of the old `AIPlayground` one | the build target changed |
| `README.md`, this file | monorepo-oriented | public context |

## The drift risk, and why it's real

Upstream evolves — the last sync brought in a Markdown-rendering feature that also added two runtime
dependencies (`marked`, `dompurify`) and a dev dependency (`jsdom`). **Dependencies drift, not just
source.** A sync that only copies `src/` will miss `package.json` changes and produce a build that
fails to install or typecheck. The re-sync procedure below always reconciles `package.json`.

## Staying in sync: the sync tool

`sync-upstream.mjs` makes syncing one command. It mirrors every upstream file **except** the
adaptations in the table above, reconciles `package.json` dependencies (never scripts or name), never
deletes (downstream-only files are reported for you to judge), and normalizes line endings so git's
normalization never shows as false drift.

Point it at the upstream with `HYDRA_UPSTREAM` (so no personal path lives in this public repo). Set it
once in your shell profile and the commands get short:

```bash
export HYDRA_UPSTREAM=/mnt/c/Mago/MagoTech/MagoTech/src/Web/HydraClient   # your MagoTech checkout, master
```

From `examples/hydra-client/`:

```bash
npm run sync:check   # am I behind? exit 1 = drift (safe: changes nothing)
npm run sync         # pull upstream in — protects adaptations, reconciles deps
```

Then, from the repo root, verify and commit:

```bash
npm install && npm run build && npm test
```

The test suite is the acceptance gate: green after a sync means the copy is faithful. CI
(`.github/workflows/ci.yml`) runs the build + both suites on every push, so a bad sync fails the PR.

**Make drift impossible to forget.** `sync:check` is cheap and exits non-zero on drift, so wire it into
whatever you already run:
- run it before cutting a hydrai.org release/deploy;
- or add it to the **MagoTech** repo's `.githooks/pre-push` (guarded to fire only when
  `src/Web/HydraClient` changed) so pushing a client change in mago reminds you to sync hydrai.
Because the upstream is a private repo the public CI can't reach, this local check is the enforcement
point — there is no server-side substitute until one of the durable options below lands.

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

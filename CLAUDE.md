# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server (the primary way to run/verify the app).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.

There is no test runner, linter, or formatter configured. The deliverable is a
screen-recordable proof-of-concept (see `SPEC.md`), so "verify" means running
`npm run dev` and stepping through Index → Refresh → Flush → Merge → Search.

## What this app is

A single-page React (Vite) app that teaches how OpenSearch/Lucene indexes and
searches documents across a distributed cluster. Everything is simulated
client-side — no backend, no localStorage, all state in React. `SPEC.md` is the
authoritative description of the intended behavior AND the OpenSearch-accuracy
guardrails (segments are immutable; a doc isn't searchable until refresh;
refresh ≠ flush; replicas live on a different node than their primary;
scatter-then-gather two-phase search). Treat those guardrails as correctness
requirements — read `SPEC.md` before changing the model.

## Architecture

The core pattern is a **pure derivation of visible state from `(cluster, op)`**,
which lets the stepper scrub any operation forwards and backwards.

- **`cluster`** (`src/cluster.js`) is the committed state: `{ shards, docs }`.
  Each shard has `buffer`, `translog`, and immutable `segments`
  (`{ id, docIds, searchable, committed }`). Topology is fixed (3 shards, 1
  replica each across 3 nodes; coordinator = node-1) via `SHARD_PLACEMENT`.
  `routeShard(docId)` is the deterministic murmur3 stand-in.

- **`op`** = `{ type, step, payload }` (held in `App.jsx`). Each op type
  (`index`, `refresh`, `flush`, `merge`, `search`) declares an ordered list of
  steps in `OP_STEPS` (`src/operations.js`); each step has the explanation text
  shown in the right panel and driven by the bottom `Stepper`.

- **Derivation** (`src/operations.js`):
  - `deriveCluster(cluster, op)` returns how the cluster should *look* at the
    current `op.step` — it clones the committed cluster and applies the partial
    effect of steps `<= op.step`. This is the single source of the rendered
    cluster; never mutate `cluster` directly to show in-progress effects.
  - `opExtra(cluster, op)` returns transient, non-persistent step info
    (in-flight doc highlights, computed search results).
  - `applyOp(cluster, op)` = `deriveCluster` at the last step; it *folds* a
    finished op into committed state. `App.start()` commits the previous
    finished op into `cluster` (via `applyOp`) before beginning a new one. This
    "fold before next" is why completed ops can stay rendered without
    double-applying — note the same care in `toggleDelete` for completed merges.

- **`App.jsx`** owns all state and orchestration: the `op` lifecycle, auto-play
  interval, derived `can*` flags (canRefresh/canFlush/canMerge/canSearch) gating
  the lifecycle buttons, and the predicted routing/color for the next document.

- **Components** (`src/components/`) are presentational, driven by the derived
  cluster + `opExtra`: `ClusterStage` (nodes/shards/segments),
  `IndexOverlay` (the index-a-document choreography), `SearchFlight` /
  `SearchResultsPanel` (scatter-gather), `InvertedIndexTable`, `Stepper`.
  Framer Motion drives the stage animations.

- **Analysis** (`src/analyzer.js`): a small stand-in for the standard analyzer —
  lowercase + split on non-(letter/number/apostrophe). No stemming/stopwords,
  keeping "your words → terms" obvious. Search relevance is term-frequency
  counting (`computeSearch`), a deliberate stand-in for BM25.

- The per-shard inverted index (`shardInvertedIndex`) is built only from
  `searchable` segments and skips `deleted` docs — buffered and tombstoned docs
  never appear in search, matching the SPEC guardrails.

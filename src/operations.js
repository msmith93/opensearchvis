import { analyze } from './analyzer'
import { cloneCluster } from './cluster'
import { flightMs } from './components/tokenFlight'

// Every user action becomes an `op = { type, step, payload }`. Each type defines
// an ordered list of steps the stepper walks. The visible state is derived
// purely from (cluster, op) via deriveCluster + opExtra, so steps can be
// scrubbed back and forth; reaching the last step folds the effect into the
// committed cluster via applyOp.
//
// Each step also declares its own `ms`: how long auto-play dwells on it before
// advancing. Steps that launch a token flight whose length depends on content
// (analysis, replicate, scatter/gather/fetch) instead compute their duration in
// stepDuration() so the flight is never clipped by the next step.
export const OP_STEPS = {
  index: [
    {
      key: 'coordinator',
      ms: 1200,
      title: '1 · Coordinator receives the request',
      blurb:
        'The client sends an index request to a coordinator node (here, Node 1). Any node can coordinate. Nothing has been routed or stored yet.',
    },
    {
      key: 'route',
      ms: 1200,
      title: '2 · Route to the primary shard',
      blurb:
        'The coordinator computes the target shard from the document id: shard = hash(_id) % number_of_shards. It forwards the document to that shard’s PRIMARY copy, which lives on one specific node.',
    },
    {
      key: 'analysis',
      ms: 2600, // overridden by stepDuration (scan + tokens-in-box + emit flight)
      title: '3 · Analysis (tokenize + normalize)',
      blurb:
        'On the primary shard, the analyzer tokenizes and lowercases each text field. Your sentences become the list of terms that will actually be indexed.',
    },
    {
      key: 'primary',
      ms: 1100,
      title: '4 · Primary buffer + translog',
      blurb:
        'The document is added to the primary shard’s in-memory buffer and appended to its translog. It is NOT searchable yet.',
    },
    {
      key: 'replicate',
      ms: 1500, // overridden by stepDuration (replica flight + dwell)
      title: '5 · Replicate to the replica',
      blurb:
        'The primary forwards the document to its replica copy on a DIFFERENT node, which buffers and logs it too. Only after the replica acknowledges does the coordinator ack the client. The data now lives on two nodes.',
    },
  ],
  refresh: [
    {
      key: 'write',
      ms: 1300,
      title: '1 · Refresh: buffers → new segments',
      blurb:
        'A refresh writes each shard’s buffered documents into ONE new, immutable segment. If a buffer holds several docs, they all land in the same segment. Existing segments are never modified.',
    },
    {
      key: 'searchable',
      ms: 1300,
      title: '2 · Segments are now searchable',
      blurb:
        'The new segments become searchable and the buffers are cleared. The translog is kept until a flush. Refresh makes data visible to search — it does not yet make it durable.',
    },
  ],
  flush: [
    {
      key: 'commit',
      ms: 1200,
      title: '1 · Flush: commit segments to disk',
      blurb:
        'A flush fsyncs the segments to disk so they are durable. Refresh ≠ flush: refresh made docs searchable; flush makes them durable.',
    },
    {
      key: 'clear',
      ms: 1200,
      title: '2 · Translog cleared',
      blurb:
        'Because the data now lives in committed segments on disk, the translog can be safely cleared.',
    },
  ],
  merge: [
    {
      key: 'select',
      ms: 1300,
      title: '1 · Select segments to merge',
      blurb:
        'On each shard with several small segments, the merge picks them to combine into one. Any tombstoned (deleted) docs are identified here — this is where they get reclaimed.',
    },
    {
      key: 'merged',
      ms: 1400,
      title: '2 · One merged segment per shard',
      blurb:
        'The small segments are replaced by a single new, larger segment; the old ones are discarded and deleted docs are physically dropped. Both primary and replica copies merge.',
    },
  ],
  search: [
    {
      key: 'coordinator',
      ms: 1400, // overridden by stepDuration (query flight)
      title: '1 · Coordinator receives the query',
      blurb:
        'The client sends a search to the coordinator (Node 1). The query string is analyzed into terms using the same analyzer used at index time.',
    },
    {
      key: 'scatter',
      ms: 1400, // overridden by stepDuration (fan-out flights)
      title: '2 · Scatter (query phase)',
      blurb:
        'The coordinator fans the query out to ONE copy of every shard — primary or replica — spread across the nodes. This is why a search runs on all nodes.',
    },
    {
      key: 'local',
      ms: 1600,
      title: '3 · Each shard searches locally',
      blurb:
        'Each contacted shard searches its own segments’ inverted indexes, scores the matching docs (a simplified relevance score), and returns only its local top hits — doc ids + scores, not the full documents.',
    },
    {
      key: 'gather',
      ms: 1600, // overridden by stepDuration (hit-id flights)
      title: '4 · Gather + merge + sort',
      blurb:
        'The coordinator gathers every shard’s local hits, merges them, and sorts by score to produce the global ranking. A term shared across shards shows up here from multiple shards.',
    },
    {
      key: 'fetch',
      ms: 1600, // overridden by stepDuration (document flights)
      title: '5 · Fetch phase',
      blurb:
        'For the winning doc ids, the coordinator asks the relevant shards for the full _source. This two-phase query-then-fetch avoids shipping full documents for non-matching hits.',
    },
    {
      key: 'return',
      ms: 1300,
      title: '6 · Return to the client',
      blurb:
        'The coordinator returns the merged, ranked results to the client. Buffered (un-refreshed) and tombstoned documents never appear.',
    },
  ],
}

export const OP_LABELS = {
  index: 'Indexing',
  refresh: 'Refresh',
  flush: 'Flush / commit',
  merge: 'Merge',
  search: 'Search',
}

export const stepsFor = (type) => OP_STEPS[type] || []
export const lastStep = (type) => stepsFor(type).length - 1

// Padding added on top of a content-driven flight so the chips visibly land
// before the step advances.
const FLIGHT_PAD = 400

// How long auto-play should dwell on the current step. Static steps use their
// declared `ms`; flight-bound steps reserve enough time for the batch of token
// chips the overlays will launch (largest concurrent flight), reusing flightMs
// so the budget can never fall short of the actual animation.
export function stepDuration(op, extra = {}) {
  if (!op) return 0
  const base = OP_STEPS[op.type]?.[op.step]?.ms ?? 1500

  if (op.type === 'index') {
    const { tokens } = op.payload.doc
    const n = tokens.title.length + tokens.body.length
    if (op.step === 2) return 1800 + flightMs(n) // scan + tokens-in-box + emit flight
    if (op.step === lastStep('index')) return flightMs(n) + FLIGHT_PAD // replica flight
  }

  if (op.type === 'search' && extra.search) {
    const n = searchFlightSize(extra.search, op.step)
    if (n != null) return flightMs(n) + FLIGHT_PAD
  }

  return base
}

// The largest single flight (in tokens) SearchFlight will launch for a step, so
// stepDuration can reserve time for it. Mirrors SearchFlight's per-step batches;
// returns null for steps that launch no flight.
function searchFlightSize(search, step) {
  if (step === 0 || step === 1) return search.terms.length // query / fan-out flights
  if (step === 3) {
    // one flight per shard with hits, up to 6 id chips each
    const sizes = Object.values(search.perShard).map((hits) => Math.min(hits.length, 6))
    return Math.max(0, ...sizes)
  }
  if (step === 4) {
    // top-5 winners grouped by shard, one flight per shard
    const byShard = {}
    for (const w of search.merged.slice(0, 5)) byShard[w.shard] = (byShard[w.shard] || 0) + 1
    return Math.max(0, ...Object.values(byShard))
  }
  return null
}

const dedupe = (arr) => [...new Set(arr)]

// Derive how the cluster should LOOK at the current op step. Folding an op into
// committed state = deriveCluster at the last step (see applyOp).
export function deriveCluster(cluster, op) {
  if (!op) return cluster
  const c = cloneCluster(cluster)
  const s = op.step

  if (op.type === 'index') {
    const { doc } = op.payload
    c.docs[doc.id] = doc
    if (s >= 3) {
      const shard = c.shards.find((sh) => sh.id === doc.shard)
      if (!shard.buffer.includes(doc.id)) shard.buffer.push(doc.id)
      if (!shard.translog.includes(doc.id)) shard.translog.push(doc.id)
    }
  } else if (op.type === 'refresh') {
    const newSegs = op.payload.newSegments
    for (const shard of c.shards) {
      if (shard.buffer.length === 0) continue
      shard.segments.push({
        id: newSegs[shard.id],
        docIds: [...shard.buffer],
        searchable: s >= 1,
        committed: false,
      })
      if (s >= 1) shard.buffer = []
    }
  } else if (op.type === 'flush') {
    for (const shard of c.shards) {
      if (s >= 0)
        shard.segments = shard.segments.map((seg) => ({ ...seg, committed: true }))
      if (s >= 1) shard.translog = []
    }
  } else if (op.type === 'merge') {
    if (s >= 1) {
      const newSegs = op.payload.newSegments
      for (const shard of c.shards) {
        const mergeable = shard.segments.filter((seg) => seg.searchable)
        if (mergeable.length < 2) continue
        const keep = []
        for (const seg of mergeable)
          for (const id of seg.docIds)
            if (!c.docs[id]?.deleted) keep.push(id)
        // physically reclaim tombstoned docs
        for (const seg of mergeable)
          for (const id of seg.docIds)
            if (c.docs[id]?.deleted) delete c.docs[id]
        const others = shard.segments.filter((seg) => !seg.searchable)
        shard.segments = [
          ...others,
          {
            id: newSegs[shard.id],
            docIds: dedupe(keep),
            searchable: true,
            committed: true,
          },
        ]
      }
    }
  }
  // search is read-only; cluster is unchanged.
  return c
}

export function applyOp(cluster, op) {
  if (!op || op.type === 'search') return cluster
  return deriveCluster(cluster, { ...op, step: lastStep(op.type) })
}

// Transient, op-specific information for the current step (highlights, the
// in-flight doc, search results) that isn't part of the persistent cluster.
export function opExtra(cluster, op) {
  if (!op) return {}
  const s = op.step

  if (op.type === 'index') {
    const { doc } = op.payload
    return {
      inflight: {
        doc,
        shard: doc.shard,
        routed: s >= 1,
        analyzed: s >= 2,
        onPrimary: s >= 3,
        onReplica: s >= 4,
      },
    }
  }
  if (op.type === 'refresh') {
    return {
      refresh: { shards: cluster.shards.filter((sh) => sh.buffer.length > 0).map((sh) => sh.id) },
    }
  }
  if (op.type === 'merge') {
    return {
      merge: {
        shards: cluster.shards
          .filter((sh) => sh.segments.filter((x) => x.searchable).length >= 2)
          .map((sh) => sh.id),
      },
    }
  }
  if (op.type === 'search') {
    return { search: computeSearch(cluster, op) }
  }
  return {}
}

// Run the (read-only) search against the committed cluster.
function computeSearch(cluster, op) {
  const terms = analyze(op.payload.query)
  const serving = {} // shardId -> { node, role }
  const perShard = {} // shardId -> [{ docId, score }]

  for (const shard of cluster.shards) {
    // Deterministic primary/replica selection (real OpenSearch uses adaptive
    // replica selection). Alternate so the demo shows both copies serving.
    const useReplica = shard.id % 2 === 1
    serving[shard.id] = useReplica
      ? { node: shard.replicaNode, role: 'replica' }
      : { node: shard.primaryNode, role: 'primary' }

    const docIds = new Set()
    for (const seg of shard.segments)
      if (seg.searchable) for (const id of seg.docIds) docIds.add(id)

    const hits = []
    for (const id of docIds) {
      const doc = cluster.docs[id]
      if (!doc || doc.deleted) continue
      let score = 0
      for (const t of terms) {
        score += doc.tokens.title.filter((x) => x === t).length
        score += doc.tokens.body.filter((x) => x === t).length
      }
      if (score > 0) hits.push({ docId: id, score })
    }
    hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    perShard[shard.id] = hits
  }

  const merged = Object.entries(perShard)
    .flatMap(([sid, hits]) => hits.map((h) => ({ ...h, shard: Number(sid) })))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  return { terms, serving, perShard, merged }
}

// Build a shard's inverted index (term -> docIds) from its searchable segments.
export function shardInvertedIndex(shard, docs) {
  const map = new Map()
  for (const seg of shard.segments) {
    if (!seg.searchable) continue
    for (const id of seg.docIds) {
      const doc = docs[id]
      if (!doc || doc.deleted) continue
      for (const field of ['title', 'body'])
        for (const term of doc.tokens[field]) {
          if (!map.has(term)) map.set(term, new Set())
          map.get(term).add(id)
        }
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, ids]) => ({ term, docIds: [...ids] }))
}

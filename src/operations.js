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

// The close-up (shard inspector) walks these steps to show what ONE shard does
// during the query phase. They are independent of the global op (which stays
// frozen on the search `local` step while the inspector is open) and are driven
// by a mini-stepper inside the inspector. Shaped like OP_STEPS.
export const LOCAL_SEARCH_STEPS = [
  {
    key: 'analyze',
    title: '1 · Analyze the query',
    blurb:
      'The shard analyzes the query string with the same analyzer used at index time, turning it into the list of terms to look up.',
  },
  {
    key: 'lookup',
    title: '2 · Look up terms per segment',
    blurb:
      'A shard is several immutable segments, each with its OWN term dictionary. Every query term is looked up in every segment’s dictionary to find that term’s posting list.',
  },
  {
    key: 'postings',
    title: '3 · Walk the posting lists',
    blurb:
      'Each matched term’s posting list names the docs that contain it. Their union (across terms and segments) is the candidate set; tombstoned / un-refreshed docs are skipped.',
  },
  {
    key: 'score',
    title: '4 · Score each candidate',
    blurb:
      'Each candidate is scored by how often the query terms appear in it. Real Lucene uses BM25 (term frequency, inverse document frequency, field-length norm); here we simplify to a term-frequency count.',
  },
  {
    key: 'topk',
    title: '5 · Keep the top hits',
    blurb:
      'A fixed-size priority queue keeps only the k highest-scoring docs; lower scores are evicted as better ones arrive. This is the shard’s local ranking.',
  },
  {
    key: 'return',
    title: '6 · Return ids + scores',
    blurb:
      'The shard returns only doc ids + scores to the coordinator — not the documents. The coordinator merges these with the other shards’ hits before fetching full sources.',
  },
]

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
    // A refresh also applies pending deletes: each tombstoned doc becomes
    // `purged`, leaving the searchable view (inverted index + search). It stays
    // physically in its segment until a merge reclaims it. Replace the doc object
    // (don't mutate) — cloneCluster shares doc refs with the committed cluster.
    if (s >= 1)
      for (const id of Object.keys(c.docs))
        if (c.docs[id].deleted && !c.docs[id].purged)
          c.docs[id] = { ...c.docs[id], purged: true }
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
            if (!c.docs[id]?.purged) keep.push(id)
        // physically reclaim deletes a refresh has already applied; a tombstone
        // that hasn't been refreshed yet is still live and survives the merge
        for (const seg of mergeable)
          for (const id of seg.docIds)
            if (c.docs[id]?.purged) delete c.docs[id]
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
    // Refresh touches a shard if it has buffered docs to segment OR a tombstone
    // to apply (a searchable segment holding a not-yet-purged deleted doc).
    const hasPendingDelete = (sh) =>
      sh.segments.some(
        (seg) =>
          seg.searchable &&
          seg.docIds.some((id) => {
            const d = cluster.docs[id]
            return d && d.deleted && !d.purged
          }),
      )
    return {
      refresh: {
        shards: cluster.shards
          .filter((sh) => sh.buffer.length > 0 || hasPendingDelete(sh))
          .map((sh) => sh.id),
      },
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
      // Tombstoned-but-not-yet-refreshed docs are still searchable (purged is
      // set by a refresh); only purged docs drop out of results.
      if (!doc || doc.purged) continue
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

// Sort a term->docIds Map into the [{term, docIds}] rows the UI renders.
const indexRows = (map) =>
  [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([term, ids]) => ({ term, docIds: [...ids] }))

// Build ONE segment's inverted index (term -> docIds). A tombstoned doc stays in
// the index until a refresh applies the delete (purged); only then does it leave.
export function segmentInvertedIndex(seg, docs) {
  const map = new Map()
  for (const id of seg.docIds) {
    const doc = docs[id]
    if (!doc || doc.purged) continue
    for (const field of ['title', 'body'])
      for (const term of doc.tokens[field]) {
        if (!map.has(term)) map.set(term, new Set())
        map.get(term).add(id)
      }
  }
  return indexRows(map)
}

// Build a shard's inverted index by merging its searchable segments' indexes.
export function shardInvertedIndex(shard, docs) {
  const map = new Map()
  for (const seg of shard.segments) {
    if (!seg.searchable) continue
    for (const { term, docIds } of segmentInvertedIndex(seg, docs)) {
      if (!map.has(term)) map.set(term, new Set())
      for (const id of docIds) map.get(term).add(id)
    }
  }
  return indexRows(map)
}

// What ONE segment physically stores, as data for the close-up's anatomy view:
// its inverted index (term dictionary + postings, via segmentInvertedIndex), the
// stored _source of each doc, and each doc's delete state (the live-docs bitset).
// Pure derivation — no model change. Includes purged docs in `docs` so the bitset
// can show them, even though segmentInvertedIndex omits them from `terms`.
export function segmentAnatomy(seg, docs) {
  return {
    id: seg.id,
    terms: segmentInvertedIndex(seg, docs),
    docs: seg.docIds
      .map((id) => docs[id])
      .filter(Boolean)
      .map((d) => ({
        id: d.id,
        title: d.title,
        body: d.body,
        deleted: !!d.deleted,
        purged: !!d.purged,
      })),
  }
}

// The shard-local query phase, as data for the inspector's stepped close-up. Pure
// like computeSearch, and uses the SAME term-frequency scoring so the numbers here
// match the cluster-level results panel.
export function computeShardSearch(shard, terms, docs, k = 3) {
  const termSet = new Set(terms)
  const segments = shard.segments
    .filter((seg) => seg.searchable)
    .map((seg) => ({ id: seg.id, rows: segmentInvertedIndex(seg, docs) }))

  // Candidate docs = those appearing in a matched (query-term) posting list.
  const candidateSet = new Set()
  for (const seg of segments)
    for (const row of seg.rows)
      if (termSet.has(row.term)) for (const id of row.docIds) candidateSet.add(id)
  const candidates = [...candidateSet].sort((a, b) => a.localeCompare(b))

  const scored = candidates
    .map((docId) => {
      const doc = docs[docId]
      const perTerm = {}
      let score = 0
      for (const t of terms) {
        const tf =
          doc.tokens.title.filter((x) => x === t).length +
          doc.tokens.body.filter((x) => x === t).length
        if (tf > 0) {
          perTerm[t] = tf
          score += tf
        }
      }
      return { docId, perTerm, score }
    })
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))

  const topk = scored.slice(0, k).map(({ docId, score }) => ({ docId, score }))
  return { segments, candidates, scored, topk, k }
}

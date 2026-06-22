import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { analyzeDoc } from './analyzer'
import { PRESETS, EXAMPLE_QUERIES, SAMPLE_DOCS } from './presets'
import {
  initialCluster,
  routeShard,
  SHARD_PLACEMENT,
} from './cluster'
import {
  OP_LABELS,
  applyOp,
  deriveCluster,
  lastStep,
  opExtra,
  stepDuration,
  stepsFor,
} from './operations'
import ClusterStage from './components/ClusterStage'
import IndexOverlay from './components/IndexOverlay'
import InvertedIndexTable from './components/InvertedIndexTable'
import SearchFlight from './components/SearchFlight'
import SearchResultsPanel from './components/SearchResultsPanel'
import ShardInspector from './components/ShardInspector'
import Stepper from './components/Stepper'
import { selectorRect } from './components/tokenFlight'

const DOC_COLORS = ['#00a3e0', '#3d7fd0', '#e0a04a', '#4ec97a', '#e0574a', '#9b7fe0']

export default function App() {
  const [cluster, setCluster] = useState(initialCluster)
  const [op, setOp] = useState(null) // { type, step, payload }
  const [opDone, setOpDone] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [indexPhase, setIndexPhase] = useState('closed') // overlay choreography phase
  const [zoomShard, setZoomShard] = useState(null) // shard id being inspected, or null
  const [zoomOrigin, setZoomOrigin] = useState('50% 50%') // transform-origin of the dive

  const [title, setTitle] = useState(PRESETS[0].title)
  const [body, setBody] = useState(PRESETS[0].body)
  const [query, setQuery] = useState(EXAMPLE_QUERIES[0])

  const docNum = useRef(1)
  const segNum = useRef(1)

  const last = op ? lastStep(op.type) : -1

  // Mark the op complete once it reaches the final step (survives scrubbing).
  // `playing` is left alone here so the scheduler below can run the last step's
  // dwell — letting the replica/return flight land — before it stops auto-play.
  useEffect(() => {
    if (op && op.step >= lastStep(op.type)) setOpDone(true)
  }, [op])

  // The magnifying glass only lives on the local-search phase. Close any open
  // inspector when the op/step leaves that phase so it can't linger as a stale
  // overlay (e.g. after Prev/Next, Play advancing, or starting a new op).
  const inLocalPhase = op?.type === 'search' && op.step === 2
  useEffect(() => {
    if (!inLocalPhase) setZoomShard(null)
  }, [inLocalPhase])

  // Opening the inspector freezes the timeline so auto-play can't advance off the
  // local phase while the user is inspecting a shard. We also compute the dive's
  // transform-origin — the clicked shard's center expressed in % of the .layout
  // box — so the whole view appears to rush toward that shard (see the .layout
  // motion.div below). DOM is at rest at click time, so the rects are accurate.
  function openZoom(id) {
    setPlaying(false)
    const role = extra.search?.serving?.[id]?.role
    const card = selectorRect(
      role === 'replica' ? `[data-replica-target="${id}"]` : `[data-shard-target="${id}"]`,
    )
    const layout = selectorRect('.layout')
    if (card && layout && layout.width && layout.height) {
      const ox = ((card.left + card.width / 2 - layout.left) / layout.width) * 100
      const oy = ((card.top + card.height / 2 - layout.top) / layout.height) * 100
      setZoomOrigin(`${ox.toFixed(1)}% ${oy.toFixed(1)}%`)
    }
    setZoomShard(id)
  }
  const closeZoom = () => setZoomShard(null)

  const derived = deriveCluster(cluster, op)
  const extra = opExtra(cluster, op)

  // Auto-play: the single timeline clock. Each step declares its own duration
  // (stepDuration); when it elapses we advance — or, at the last step, stop,
  // which gives the final flight its dwell. The effect re-subscribes on
  // [playing, op], so manual Prev/Next/Pause (which change those) cancel any
  // pending timer. `extra` is read for content-aware search durations but is
  // intentionally NOT a dep: it gets a fresh value on every op change.
  useEffect(() => {
    if (!playing || !op) return
    const atLast = op.step >= lastStep(op.type)
    const id = setTimeout(() => {
      if (atLast) setPlaying(false)
      else setOp((prev) => (prev ? { ...prev, step: prev.step + 1 } : prev))
    }, stepDuration(op, extra))
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, op])
  const canStartNew = op === null || opDone

  // The committed cluster as it will be once the current (completed) op folds in.
  // Null while an op is mid-walk, which disables the action buttons.
  const base = canStartNew ? (op ? applyOp(cluster, op) : cluster) : null
  const hasBuffered = !!base && base.shards.some((s) => s.buffer.length > 0)
  const hasPendingDelete =
    !!base && Object.values(base.docs).some((d) => d.deleted && !d.purged)
  const hasUncommitted =
    !!base && base.shards.some((s) => s.segments.some((seg) => !seg.committed))
  const hasMergeable =
    !!base &&
    base.shards.some((s) => s.segments.filter((seg) => seg.searchable).length >= 2)
  const hasSearchable =
    !!base && base.shards.some((s) => s.segments.some((seg) => seg.searchable))

  const hasText = title.trim() || body.trim()
  const canIndex = hasText && canStartNew && !playing

  // Predicted routing + colour for the NEXT document, so the overlay can fly
  // tokens to the correct shard and tint them before the op actually starts.
  const nextShard = routeShard(`doc-${docNum.current}`)
  const nextColor = DOC_COLORS[(docNum.current - 1) % DOC_COLORS.length]
  const canRefresh = (hasBuffered || hasPendingDelete) && !playing
  const canFlush = hasUncommitted && !playing
  const canMerge = hasMergeable && !playing
  const canSearch = hasSearchable && query.trim() && !playing

  function start(type, payload) {
    setCluster(base)
    setOp({ type, step: 0, payload })
    setOpDone(false)
    setPlaying(true)
  }

  function startIndex() {
    if (!canIndex) return
    const id = `doc-${docNum.current}`
    const color = DOC_COLORS[(docNum.current - 1) % DOC_COLORS.length]
    docNum.current += 1
    const doc = {
      id,
      title: title.trim(),
      body: body.trim(),
      tokens: analyzeDoc({ title: title.trim(), body: body.trim() }),
      deleted: false,
      color,
      shard: routeShard(id),
    }
    start('index', { doc })
  }

  function startRefresh() {
    if (!canRefresh) return
    const newSegments = {}
    base.shards.forEach((s) => {
      if (s.buffer.length > 0) newSegments[s.id] = `seg-${segNum.current++}`
    })
    start('refresh', { newSegments })
  }

  function startFlush() {
    if (!canFlush) return
    start('flush', {})
  }

  function startMerge() {
    if (!canMerge) return
    const newSegments = {}
    base.shards.forEach((s) => {
      if (s.segments.filter((seg) => seg.searchable).length >= 2)
        newSegments[s.id] = `seg-${segNum.current++}`
    })
    start('merge', { newSegments })
  }

  function startSearch() {
    if (!canSearch) return
    start('search', { query: query.trim() })
  }

  function step(delta) {
    setPlaying(false)
    setOp((prev) => {
      if (!prev) return prev
      const next = Math.max(0, Math.min(lastStep(prev.type), prev.step + delta))
      return { ...prev, step: next }
    })
  }

  function toggleDelete(id) {
    const flip = (c) => {
      const d = c.docs[id]
      if (!d) return c
      // Delete records a tombstone; the doc stays searchable until the next
      // refresh applies it (sets `purged`). Undo fully restores the doc.
      const next = d.deleted
        ? { ...d, deleted: false, purged: false }
        : { ...d, deleted: true }
      return { ...c, docs: { ...c.docs, [id]: next } }
    }
    // A finished op is still "active" and re-derived every render. For a completed
    // REFRESH that means a fresh tombstone would be applied (purged) immediately on
    // re-derivation instead of waiting for the next refresh; a completed MERGE could
    // likewise reclaim an applied delete. So, like start(), fold the finished op
    // into the committed cluster first, then tombstone against that.
    if (op && opDone && op.type !== 'search') {
      setCluster(flip(applyOp(cluster, op)))
      setOp(null)
      setOpDone(false)
    } else {
      setCluster((prev) => flip(prev))
    }
  }

  // Seed a ready-to-search cluster directly: build the sample docs, route each by
  // id, and place them into searchable+committed segments (≤2 docs each) grouped by
  // shard. This gives a zoomed shard several docs across multiple segments so the
  // close-up's scoring + priority-queue steps have something to show.
  function loadSampleDocs() {
    const c = initialCluster()
    const byShard = { 0: [], 1: [], 2: [] }
    // Tombstone one doc so the close-up's deletes (live-docs) bitset isn't trivial.
    // It stays a tombstone (not purged), so per the SPEC guardrail it is still
    // searchable until a refresh applies the delete.
    const tombstoned = 'doc-8'
    SAMPLE_DOCS.forEach((d, i) => {
      const id = `doc-${i + 1}`
      const doc = {
        id,
        title: d.title,
        body: d.body,
        tokens: analyzeDoc({ title: d.title, body: d.body }),
        deleted: id === tombstoned,
        color: DOC_COLORS[i % DOC_COLORS.length],
        shard: routeShard(id),
      }
      c.docs[id] = doc
      byShard[doc.shard].push(id)
    })
    let seg = 1
    for (const shard of c.shards) {
      const ids = byShard[shard.id]
      for (let j = 0; j < ids.length; j += 2)
        shard.segments.push({
          id: `seg-${seg++}`,
          docIds: ids.slice(j, j + 2),
          searchable: true,
          committed: true,
        })
    }
    setCluster(c)
    setOp(null)
    setOpDone(false)
    setPlaying(false)
    setIndexPhase('closed')
    setZoomShard(null)
    docNum.current = SAMPLE_DOCS.length + 1
    segNum.current = seg
  }

  function reset() {
    setCluster(initialCluster())
    setOp(null)
    setOpDone(false)
    setPlaying(false)
    setIndexPhase('closed')
    docNum.current = 1
    segNum.current = 1
  }

  const currentStep = op ? stepsFor(op.type)[op.step] : null
  const allDocs = Object.values(derived.docs).sort(
    (a, b) => docOrder(a.id) - docOrder(b.id),
  )

  return (
    <div className="app">
      <div className="topbar">
        <h1>OpenSearch Cluster Visualizer</h1>
        <span className="sub">
          Routing & replication across a 3-node cluster, the write path, and
          scatter-gather search
        </span>
      </div>

      <motion.div
        className="layout"
        style={{ transformOrigin: zoomOrigin }}
        animate={
          zoomShard != null
            ? { scale: 1.7, opacity: 0 }
            : { scale: 1, opacity: 1 }
        }
        transition={{ type: 'tween', ease: 'easeInOut', duration: 0.5 }}
      >
        {/* ---------------- Left: controls ---------------- */}
        <div className="col">
          <p className="section-title">Lifecycle</p>
          <div className="btn-grid">
            <button className="btn" onClick={startRefresh} disabled={!canRefresh}>
              Refresh
            </button>
            <button className="btn" onClick={startFlush} disabled={!canFlush}>
              Flush
            </button>
            <button className="btn" onClick={startMerge} disabled={!canMerge}>
              Merge
            </button>
            <button className="btn" onClick={reset}>
              Reset
            </button>
          </div>

          {(indexPhase === 'closed' || indexPhase === 'done') && (
            <button
              className="btn primary block"
              style={{ marginTop: 14 }}
              onClick={() => setIndexPhase('editing')}
            >
              ＋ Index a document
            </button>
          )}

          <button className="btn block" style={{ marginTop: 8 }} onClick={loadSampleDocs}>
            Load sample docs
          </button>

          <p className="section-title" style={{ marginTop: 20 }}>
            Search
          </p>
          <div className="search-row">
            <input
              type="text"
              data-search-source
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search terms…"
            />
            <button className="btn primary" onClick={startSearch} disabled={!canSearch}>
              Search
            </button>
          </div>
          <div className="presets">
            {EXAMPLE_QUERIES.map((q) => (
              <button key={q} className="preset-chip" onClick={() => setQuery(q)}>
                {q}
              </button>
            ))}
          </div>

          <p className="hint">
            Index a few docs (watch each route to a shard and replicate to a
            second node), <b>Refresh</b> to build segments, <b>Flush</b> to
            commit, then <b>Search</b> to watch the coordinator scatter to all
            shards and gather a ranked response.
          </p>

          {allDocs.length > 0 && (
            <div className="doc-list">
              <p className="section-title">Documents</p>
              {allDocs.map((d) => (
                <div key={d.id} className={'doc-row' + (d.deleted ? ' deleted' : '')}>
                  <span className="dot" style={{ background: d.color }} />
                  <span className="doc-id">{d.id}</span>
                  <span className="doc-shard">
                    {d.deleted
                      ? d.purged
                        ? 'deleted'
                        : 'tombstoned · refresh to apply'
                      : `→ shard ${d.shard}`}
                  </span>
                  <button className="mini" onClick={() => toggleDelete(d.id)}>
                    {d.deleted ? 'undo' : 'delete'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---------------- Center: cluster ---------------- */}
        <div className="col">
          <p className="section-title">Cluster</p>
          <ClusterStage cluster={derived} extra={extra} op={op} onZoom={openZoom} />
        </div>

        {/* ---------------- Right: explain + inspector ---------------- */}
        <div className="col">
          <p className="section-title">What's happening</p>
          {currentStep ? (
            <div className="explain">
              <h3>{currentStep.title}</h3>
              <p>{currentStep.blurb}</p>
            </div>
          ) : (
            <div className="explain idle">
              <h3>Ready</h3>
              <p>
                Index a document to begin, or run a search once some documents
                are searchable.
              </p>
            </div>
          )}

          {op?.type === 'search' ? (
            <SearchResultsPanel
              search={extra.search}
              step={op.step}
              docs={derived.docs}
            />
          ) : (
            <InvertedIndexTable cluster={derived} />
          )}
        </div>
      </motion.div>

      {/* ---------------- Bottom: stepper ---------------- */}
      <Stepper
        steps={op ? stepsFor(op.type) : []}
        step={op ? op.step : -1}
        opLabel={op ? OP_LABELS[op.type] : ''}
        playing={playing}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      {/* ---------------- Overlay: indexing experience ---------------- */}
      <IndexOverlay
        presets={PRESETS}
        title={title}
        body={body}
        setTitle={setTitle}
        setBody={setBody}
        canIndex={canIndex}
        targetShard={nextShard}
        docColor={nextColor}
        onIndex={startIndex}
        op={op}
        playing={playing}
        phase={indexPhase}
        setPhase={setIndexPhase}
      />

      {/* ---------------- Overlay: search scatter-gather flights ---------------- */}
      <SearchFlight op={op} search={extra.search} docs={derived.docs} />

      {/* ---------------- Overlay: zoom into a serving shard's local search ---------------- */}
      <ShardInspector
        shard={zoomShard != null ? derived.shards.find((s) => s.id === zoomShard) : null}
        search={extra.search}
        docs={derived.docs}
        query={op?.type === 'search' ? op.payload.query : ''}
        onClose={closeZoom}
      />
    </div>
  )
}

function docOrder(id) {
  const n = parseInt(id.replace(/\D/g, ''), 10)
  return Number.isNaN(n) ? 0 : n
}

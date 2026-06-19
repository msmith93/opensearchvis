import { useEffect, useRef, useState } from 'react'
import { analyzeDoc } from './analyzer'
import { PRESETS, EXAMPLE_QUERIES } from './presets'
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
import Stepper from './components/Stepper'

const DOC_COLORS = ['#00a3e0', '#3d7fd0', '#e0a04a', '#4ec97a', '#e0574a', '#9b7fe0']

export default function App() {
  const [cluster, setCluster] = useState(initialCluster)
  const [op, setOp] = useState(null) // { type, step, payload }
  const [opDone, setOpDone] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [indexPhase, setIndexPhase] = useState('closed') // overlay choreography phase

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

      <div className="layout">
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
          <ClusterStage cluster={derived} extra={extra} op={op} />
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
      </div>

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
    </div>
  )
}

function docOrder(id) {
  const n = parseInt(id.replace(/\D/g, ''), 10)
  return Number.isNaN(n) ? 0 : n
}

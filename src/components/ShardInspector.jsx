import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { rectCenter, selectorRect } from './tokenFlight'
import { LOCAL_SEARCH_STEPS, computeShardSearch, segmentAnatomy } from '../operations'
import Stepper from './Stepper'

const DWELL_MS = 1900 // per-step auto-play dwell, ~ the main timeline's feel
const TOPK = 3 // small demo priority-queue size (real Lucene default is 10)

// Step indices into LOCAL_SEARCH_STEPS: analyze(0) lookup(1) postings(2)
// score(3) topk(4) return(5).

// A zoom-in overlay for a single serving shard during the local-search phase.
// The dive/zoom entrance is unchanged. INSIDE, a persistent "segment anatomy"
// diagram (inverted index = term dictionary + postings, stored _source, deletes
// bitset) stays visible while a mini-stepper walks the six query-phase steps,
// lighting up the parts of the diagram each step touches.
export default function ShardInspector({ shard, search, docs, query, onClose }) {
  const open = !!shard && !!search

  let initial = { opacity: 0, scale: 0.25 }
  if (open) {
    const role = search.serving[shard.id]?.role
    const c = rectCenter(
      selectorRect(
        role === 'replica'
          ? `[data-replica-target="${shard.id}"]`
          : `[data-shard-target="${shard.id}"]`,
      ),
    )
    if (c)
      initial = {
        opacity: 0,
        scale: 0.25,
        x: c.x - window.innerWidth / 2,
        y: c.y - window.innerHeight / 2,
      }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="shard-inspector-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className="shard-inspector"
            initial={initial}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={initial}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
          >
            <InspectorBody
              shard={shard}
              search={search}
              docs={docs}
              query={query}
              onClose={onClose}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function InspectorBody({ shard, search, docs, query, onClose }) {
  const sv = search.serving[shard.id]
  const terms = search.terms
  const local = useMemo(
    () => computeShardSearch(shard, terms, docs, TOPK),
    [shard, terms, docs],
  )
  const anatomy = useMemo(
    () =>
      shard.segments.filter((s) => s.searchable).map((s) => segmentAnatomy(s, docs)),
    [shard, docs],
  )

  const last = LOCAL_SEARCH_STEPS.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing) return
    if (step >= last) {
      setPlaying(false)
      return
    }
    const id = setTimeout(() => setStep((s) => Math.min(last, s + 1)), DWELL_MS)
    return () => clearTimeout(id)
  }, [playing, step, last])

  const go = (delta) => {
    setPlaying(false)
    setStep((s) => Math.max(0, Math.min(last, s + delta)))
  }

  const current = LOCAL_SEARCH_STEPS[step]
  const focus = {
    step,
    queryTerms: new Set(terms),
    candidateSet: new Set(local.candidates),
    dictHL: step >= 1, // term dictionary lookup
    postingsHL: step >= 2, // postings walked
    sourceHL: step >= 5, // _source read on return/fetch
  }

  return (
    <>
      <div className="si-head">
        <div className="si-title">
          shard {shard.id} ·{' '}
          <span className={'role-badge ' + sv.role}>{sv.role}</span> on {sv.node}
          <span className="si-sub"> — local search</span>
        </div>
        <button className="si-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="si-explain">
        <h4>{current.title}</h4>
        <p>{current.blurb}</p>
      </div>

      <div className="si-scroll">
        {/* Current step's focus content, ABOVE the persistent anatomy. */}
        {step === 0 ? (
          <AnalyzeStage query={query} terms={terms} />
        ) : (
          <>
            <div className="si-query-bar">
              <span className="si-query-label">query</span>
              {query && <span className="si-query-str">“{query}”</span>}
              <span className="si-arrow">→</span>
              {terms.length ? (
                terms.map((t) => (
                  <span key={t} className="term-chip">
                    {t}
                  </span>
                ))
              ) : (
                <em className="empty-note">no terms</em>
              )}
            </div>
            <TransientPanel step={step} local={local} terms={terms} docs={docs} />
          </>
        )}

        <p className="section-title">Segment anatomy — what this shard stores</p>
        <div className="si-anatomy">
          {anatomy.length === 0 ? (
            <div className="empty-note small">nothing searchable on this shard</div>
          ) : (
            anatomy.map((seg) => (
              <AnatomyCard key={seg.id} seg={seg} focus={focus} docs={docs} />
            ))
          )}
        </div>
      </div>

      <div className="si-stepper">
        <Stepper
          steps={LOCAL_SEARCH_STEPS}
          step={step}
          opLabel={`shard ${shard.id} · local search`}
          playing={playing}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>
    </>
  )
}

// One segment's stored structures: inverted index (term dictionary | postings),
// stored _source, and the deletes (live-docs) bitset. The same card lights up
// differently depending on `focus` (which query step we're on).
function AnatomyCard({ seg, focus, docs }) {
  const { queryTerms, dictHL, postingsHL, sourceHL, candidateSet } = focus
  const rowsRef = useRef(null)
  const matchRef = useRef(null)

  // When the lookup step activates, scroll this segment's term dictionary so its
  // first matching term is in view. Contained to the .anat-ii-rows scroller.
  useEffect(() => {
    if (!dictHL || !rowsRef.current || !matchRef.current) return
    const rows = rowsRef.current
    const top =
      rows.scrollTop +
      (matchRef.current.getBoundingClientRect().top - rows.getBoundingClientRect().top)
    rows.scrollTo({ top, behavior: 'smooth' })
  }, [dictHL])

  let firstMatchSeen = false
  return (
    <div className="anat-card">
      <div className="anat-card-head">
        <span className="anat-seg-id">
          <span className="lock">🔒</span> {seg.id}
        </span>
        <span className="anat-bitset" title="live-docs bitset (deletes)">
          Live-Docs:
          {seg.docs.map((d) => (
            <span
              key={d.id}
              className={'anat-bit' + (d.deleted || d.purged ? ' dead' : ' live')}
            >
              {d.id} {d.deleted || d.purged ? '✗' : '✓'}
            </span>
          ))}
        </span>
      </div>

      <div className="anat-body">
        {/* inverted index: term dictionary | postings */}
        <div className="anat-ii">
          <div className="anat-ii-label">inverted index</div>
          <div className="anat-ii-cols">
            <div className="anat-col-head">term dictionary</div>
            <div className="anat-col-head">postings</div>
          </div>
          <div className="anat-ii-rows" ref={rowsRef}>
            {seg.terms.map(({ term, docIds }) => {
              const isQ = queryTerms.has(term)
              const isFirstMatch = isQ && !firstMatchSeen
              if (isFirstMatch) firstMatchSeen = true
              return (
                <div
                  key={term}
                  ref={isFirstMatch ? matchRef : null}
                  className={
                    'anat-row' +
                    (isQ && dictHL ? ' term-active' : '') +
                    (dictHL && !isQ ? ' dim' : '')
                  }
                >
                  <span className="anat-term">{term}</span>
                  <span className="anat-postings">
                    {docIds.map((id) => (
                      <DocChip
                        key={id}
                        id={id}
                        docs={docs}
                        hit={isQ && postingsHL && candidateSet.has(id)}
                      />
                    ))}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* stored _source */}
        <div className={'anat-source' + (sourceHL ? ' active' : '')}>
          <div className="anat-ii-label">stored _source</div>
          {seg.docs.map((d) => (
            <div className="anat-doc" key={d.id}>
              <DocChip id={d.id} docs={docs} />
              <span className="anat-doc-text">
                {d.title}
                {d.body ? ` — ${d.body}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Step 1 (analyze): the query arrives in a box, a scan-line sweeps it, then the
// extracted token chips appear — echoing the cluster-level index choreography.
function AnalyzeStage({ query, terms }) {
  const [scanning, setScanning] = useState(true)
  const [showTokens, setShowTokens] = useState(false)

  useEffect(() => {
    setScanning(true)
    setShowTokens(false)
    const t = setTimeout(() => {
      setScanning(false)
      setShowTokens(true)
    }, 1000)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="si-analyze">
      <div className={'si-query-box' + (scanning ? ' scanning' : '')}>
        {scanning && <div className="scan-line" />}
        <span className="si-query-label">query</span>
        <span className="si-query-str">“{query}”</span>
      </div>
      <div className="si-analyze-arrow">↓ analyze (tokenize + normalize)</div>
      <div className="chip-row si-analyze-tokens">
        {showTokens &&
          (terms.length ? (
            terms.map((t, i) => (
              <motion.span
                key={t}
                className="term-chip"
                initial={{ opacity: 0, scale: 0.6, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ delay: i * 0.08, type: 'spring', stiffness: 320, damping: 22 }}
              >
                {t}
              </motion.span>
            ))
          ) : (
            <em className="empty-note">no terms</em>
          ))}
      </div>
    </div>
  )
}

// The transient query-time structures, shown for the step that produces them.
function TransientPanel({ step, local, terms, docs }) {
  if (step === 2) return <CandidateSet candidates={local.candidates} docs={docs} />
  if (step === 3) return <ScoreList scored={local.scored} terms={terms} docs={docs} />
  if (step === 4) return <PriorityQueue scored={local.scored} k={local.k} docs={docs} />
  if (step === 5) return <ReturnList topk={local.topk} docs={docs} />
  return null
}

function CandidateSet({ candidates, docs }) {
  return (
    <div className="si-block">
      <p className="section-title">Candidate docs (union of posting lists)</p>
      {candidates.length === 0 ? (
        <div className="ss-none">no candidates — no doc matched any term</div>
      ) : (
        <div className="chip-row">
          {candidates.map((id) => (
            <DocChip key={id} id={id} docs={docs} hit />
          ))}
        </div>
      )}
    </div>
  )
}

function ScoreList({ scored, terms, docs }) {
  if (scored.length === 0) return <div className="ss-none">no candidates to score</div>
  return (
    <div className="si-block">
      <p className="section-title">Score each candidate (term-frequency stand-in)</p>
      <div className="si-scores">
        {scored.map((s) => (
          <div className="si-score-row" key={s.docId}>
            <DocChip id={s.docId} docs={docs} hit />
            <span className="si-score-terms">
              {terms
                .filter((t) => s.perTerm[t])
                .map((t) => (
                  <span key={t} className="si-tf">
                    {t} ×{s.perTerm[t]}
                  </span>
                ))}
            </span>
            <span className="score">= {s.score}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PriorityQueue({ scored, k, docs }) {
  const kept = scored.slice(0, k)
  const evicted = scored.slice(k)
  const slots = Array.from({ length: k })
  return (
    <div className="si-block">
      <p className="section-title">Top-k priority queue (k = {k}, a min-heap)</p>
      <div className="si-pq">
        {slots.map((_, i) => {
          const s = kept[i]
          return (
            <div className={'si-pq-slot' + (s ? ' filled' : '')} key={i}>
              <span className="si-pq-rank">#{i + 1}</span>
              {s ? (
                <>
                  <DocChip id={s.docId} docs={docs} hit />
                  <span className="score">{s.score}</span>
                </>
              ) : (
                <span className="empty-note small">empty</span>
              )}
            </div>
          )
        })}
      </div>
      {evicted.length > 0 && (
        <div className="si-evicted">
          evicted:{' '}
          {evicted.map((s) => (
            <span key={s.docId} className="si-evicted-chip">
              <DocChip id={s.docId} docs={docs} />
              <span className="score">{s.score}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ReturnList({ topk, docs }) {
  return (
    <div className="si-block">
      <div className="ii-meta">
        Only doc ids + scores leave the shard. The <b>_source</b> stays in the
        segment (highlighted above) — it is fetched later, only for the winners.
      </div>
      {topk.length === 0 ? (
        <div className="ss-none">no local hits</div>
      ) : (
        <div className="ss-hits">
          {topk.map((h) => (
            <div className="ss-hit" key={h.docId}>
              <DocChip id={h.docId} docs={docs} hit />
              <span className="score">score {h.score}</span>
            </div>
          ))}
        </div>
      )}
      <div className="si-return-note">↩ returned to coordinator</div>
    </div>
  )
}

function DocChip({ id, docs, hit }) {
  const d = docs[id]
  return (
    <span
      className={'doc-chip' + (d?.deleted ? ' deleted' : '') + (hit ? ' hit' : '')}
      style={{ background: d?.color || '#888' }}
    >
      {id}
    </span>
  )
}

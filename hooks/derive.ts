// Pure functions over a snapshot: no `$`, no drawing. The panel, the status line and the
// status tool all read the same derived values from here.
import type { BmadEpic, BmadLoopRun, BmadProjectSummary, BmadScanResult, BmadSnapshot, BmadStory } from '../types'
import { BACKLOG_EPIC, isDroppedStatus } from './collect'

// The most projects kept in the store. A cut keeps the most recently seen.
export const MAX_PROJECTS = 200
// A saved project is rewritten at least this often even when nothing else changed.
export const SEEN_REFRESH_MS = 5 * 60 * 1000

// Work that was given up (dropped, cancelled), and work that needs nothing more (done or dropped).
export const isDropped = isDroppedStatus
export const isClosed = (status: string | undefined): boolean => status === 'done' || isDropped(status)

export function statusColor(s: string | undefined): string | undefined {
  if (isDropped(s)) return 'inactive'
  const v = (s ?? '').toLowerCase()
  if (/^(done|final|complete|completed|finished|pass|accepted|approved|built|approve)/.test(v)) return 'success'
  if (/(fail|crash|reject|block|escalat|error|interrupted|not_met)/.test(v)) return 'error'
  if (/(in-progress|in_progress|running|dev-|review-|committing|triage-|building|stopping)/.test(v)) return 'warning'
  if (/(review|concerns|paused|awaiting|waived|deferred|in-review)/.test(v)) return 'suggestion'
  if (/(ready|draft|open)/.test(v)) return 'claude'
  if (/(backlog|optional|pending|not-started|not_started|unknown)/.test(v)) return 'inactive'
  return undefined
}

export function bar(done: number, total: number, width: number): string {
  const w = Math.max(4, width)
  const filled = total > 0 ? Math.round((done / total) * w) : 0
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

export function pct(done: number, total: number): string {
  return total > 0 ? `${Math.round((done / total) * 100)}%` : '–'
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

export function version(s: BmadSnapshot): string {
  return `${s.project.bmadVersion ?? '?'}${s.project.layout ? ` (${s.project.layout})` : ''}`
}

export function allStories(s: BmadSnapshot): BmadStory[] {
  return s.sprint?.epics.flatMap(e => e.stories) ?? []
}

// The stories of an epic that still count: not dropped, and not in a dropped epic.
export function epicLive(e: BmadEpic): BmadStory[] {
  // in a dropped epic only what was already delivered still counts
  return e.stories.filter(x => !isDropped(x.status) && (x.status === 'done' || !isDropped(e.status)))
}

export const epicTotal = (e: BmadEpic): number => epicLive(e).length
export const epicDropped = (e: BmadEpic): number => e.stories.length - epicLive(e).length

export function epicDone(e: BmadEpic): number {
  return epicLive(e).filter(x => x.status === 'done').length
}

// Every story of the sprint that still counts.
export function liveStories(s: BmadSnapshot): BmadStory[] {
  return s.sprint?.epics.flatMap(epicLive) ?? []
}

// Delivered work over work that still counts, dropped stories left out of both.
export function progress(s: BmadSnapshot): { done: number; total: number; dropped: number } {
  const live = liveStories(s)
  return { done: live.filter(x => x.status === 'done').length, total: live.length, dropped: allStories(s).length - live.length }
}

// sprint-status often leaves an epic at backlog after its stories are done
export function epicStatus(e: BmadEpic): string {
  if (isDropped(e.status)) return 'dropped'
  const live = epicLive(e)
  if (e.stories.length && live.length === 0) return 'dropped'
  if (live.length && epicDone(e) === live.length) return 'done'
  if (live.some(x => x.status !== 'backlog')) return 'in-progress'
  return e.status
}

// the first epic with work left, else the last one that was not dropped
export function currentEpic(s: BmadSnapshot): BmadEpic | undefined {
  const epics = s.sprint?.epics ?? []
  return epics.find(e => epicLive(e).some(x => x.status !== 'done')) ?? [...epics].reverse().find(e => epicStatus(e) !== 'dropped') ?? epics[epics.length - 1]
}

// The v7 epic that holds stories without an epic has the num 999; people read "backlog".
export function epicLabel(num: number, prefix = 'E'): string {
  return num === BACKLOG_EPIC ? 'backlog' : `${prefix}${num}`
}

export function epicHeading(e: BmadEpic): string {
  if (e.num === BACKLOG_EPIC) return 'Backlog'
  return `Epic ${e.num}${e.title ? `: ${e.title}` : ''}`
}

// "1.2" for a story of epic 1; a backlog story has no epic, so just its own id (or nothing)
export function storyRef(x: BmadStory): string {
  return x.epic === BACKLOG_EPIC ? x.num : `${x.epic}.${x.num}`
}

export function isWip(x: BmadStory): boolean {
  return x.status === 'in-progress' || x.status === 'review'
}

export function nextStory(s: BmadSnapshot): BmadStory | undefined {
  const stories = liveStories(s)
  return stories.find(x => x.status === 'ready-for-dev') ?? stories.find(x => x.status === 'backlog')
}

export function liveRun(s: BmadSnapshot): BmadLoopRun | undefined {
  return s.loop.runs.find(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused') ?? s.loop.runs[0]
}

export type Alert = { level: 'error' | 'warning' | 'suggestion'; text: string }

export function alerts(s: BmadSnapshot): Alert[] {
  const out: Alert[] = []
  for (const r of s.loop.runs.slice(0, 3)) {
    if (r.status === 'paused') out.push({ level: 'warning', text: `Loop ${r.ref} paused (${r.pausedStage ?? '?'}): ${r.pausedReason ?? ''}` })
    if (r.status === 'crashed') out.push({ level: 'error', text: `Loop ${r.ref} crashed: ${r.crashError ?? ''}` })
    if (r.pendingDecision) out.push({ level: 'warning', text: `Loop ${r.ref} waiting for a decision: ${r.pendingDecision}` })
    if (r.status === 'running' && r.heartbeatAgeS !== undefined && r.heartbeatAgeS > 90) out.push({ level: 'warning', text: `Loop ${r.ref}: heartbeat stale for ${r.heartbeatAgeS}s` })
    for (const a of r.attention.slice(-2)) if (/CRITICAL|PAUSED/.test(a) && r.status !== 'finished') out.push({ level: 'error', text: a })
  }
  if (s.sprint?.stale) out.push({ level: 'suggestion', text: `sprint-status.yaml out of date (${s.sprint.lastUpdated ?? s.sprint.generated})` })
  const openItems = openActionItems(s)
  if (openItems) out.push({ level: 'suggestion', text: `${openItems} open retrospective action item(s)` })
  const reviewOpen = openReviewFindings(s)
  if (reviewOpen) out.push({ level: 'warning', text: `${reviewOpen} open code review finding(s)` })
  const failing = s.qualitySummary.gates.filter(g => /fail/i.test(g.status)).length
  if (failing) out.push({ level: 'error', text: `${failing} TEA quality gate(s) FAIL` })
  const blocked = s.buildAuto.byStatus.blocked ?? 0
  if (blocked) out.push({ level: 'warning', text: `${blocked} blocked build-auto result(s)` })
  if (s.changeProposals.length) out.push({ level: 'suggestion', text: `${s.changeProposals.length} sprint change proposal(s)` })
  const openDw = openDeferred(s)
  if (openDw) out.push({ level: 'suggestion', text: `${openDw} open deferred work item(s)` })
  if (s.inProgressSessions.length) out.push({ level: 'suggestion', text: `${s.inProgressSessions.length} unfinished BMAD session(s) (memlog)` })
  for (const e of s.errors) out.push({ level: 'error', text: e })
  return out
}

export const openActionItems = (s: BmadSnapshot): number => s.sprint?.actionItems.filter(a => a.status !== 'done').length ?? 0
export const openDeferred = (s: BmadSnapshot): number => s.deferred.filter(d => d.status !== 'done').length
export const openReviewFindings = (s: BmadSnapshot): number => liveStories(s).reduce((n, x) => n + (x.reviewOpen ?? 0), 0)

export function statusLine(s: BmadSnapshot): string | undefined {
  if (!s.found) return undefined
  const parts = [`BMAD ${s.project.name ?? ''}`.trim()]
  const stories = liveStories(s)
  if (stories.length) {
    const ep = currentEpic(s)
    if (ep && epicTotal(ep)) parts.push(`${epicLabel(ep.num)} ${epicDone(ep)}/${epicTotal(ep)}`)
    parts.push(`${progress(s).done}/${stories.length} stories`)
    const wip = stories.find(isWip)
    if (wip) parts.push(`▸ ${storyRef(wip) || wip.key} ${wip.status}`)
  }
  const run = liveRun(s)
  if (run && (run.status === 'running' || run.status === 'paused' || run.status === 'stopping'))
    parts.push(`loop ${run.status === 'running' ? '▶' : '⏸'} ${run.currentStory ? `${run.currentStory.slice(0, 24)} ${run.currentPhase ?? ''}` : run.ref}`.trim())
  return parts.join(' · ')
}

export function summaryOf(s: BmadSnapshot, now: number = Date.now()): BmadProjectSummary {
  const { done, total } = progress(s)
  const wip = liveStories(s).find(isWip)
  const run = liveRun(s)
  return {
    root: s.root,
    name: s.project.name,
    lastSeen: now,
    done,
    total,
    inProgress: wip ? `${storyRef(wip)} ${wip.title ?? ''}`.trim() : undefined,
    loop: run ? `${run.ref} ${run.status}` : undefined,
  }
}

// Whether a project's summary differs from the saved one in anything but `lastSeen`.
export function summaryChanged(a: BmadProjectSummary, b: BmadProjectSummary): boolean {
  return a.root !== b.root || a.name !== b.name || a.done !== b.done || a.total !== b.total || a.inProgress !== b.inProgress || a.loop !== b.loop
}

// Whether a refresh has to write the project list: the summary changed, the project is new,
// or the stored `lastSeen` is getting old.
export function shouldStore(saved: BmadProjectSummary | undefined, next: BmadProjectSummary): boolean {
  if (!saved) return true
  return summaryChanged(saved, next) || next.lastSeen - saved.lastSeen >= SEEN_REFRESH_MS
}

// Keeps the most recently seen when the list is over the cap.
export function capProjects(list: BmadProjectSummary[], max: number = MAX_PROJECTS): BmadProjectSummary[] {
  if (list.length <= max) return list
  return [...list].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, max)
}

// The folders a scan searches: the configured ones, else two levels above the project.
// The Projects tab and `/bmad-dashboard scan` both use this.
export function scanDirsFor(scanRoots: string, root: string): string[] {
  const configured = scanRoots
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
  if (configured.length) return configured
  if (!root) return []
  const parts = root.split('/')
  return [parts.slice(0, Math.max(2, parts.length - 2)).join('/') || root]
}

export function scanText(r: BmadScanResult): string {
  return `${r.found} found, ${r.added} new${r.removed ? `, ${r.removed} removed` : ''}`
}

// What the status tool returns by default: where the project stands, in a few hundred bytes.
export function toolSummary(s: BmadSnapshot) {
  const run = liveRun(s)
  const story = (x: BmadStory) => ({ ref: storyRef(x) || x.key, title: x.title, status: x.status })
  const next = nextStory(s)
  return {
    project: s.project.name,
    bmadVersion: s.project.bmadVersion,
    layout: s.project.layout,
    modules: s.modules.map(m => m.name),
    git: s.git && { branch: s.git.branch, dirty: s.git.dirty, ahead: s.git.ahead, behind: s.git.behind, lastCommit: s.git.lastCommit },
    sprint: s.sprint ? { counts: s.sprint.counts, stale: s.sprint.stale, dropped: progress(s).dropped } : undefined,
    sprintNote: s.sprint ? undefined : s.sprintNote,
    epics: (s.sprint?.epics ?? []).map(e => ({ num: e.num, label: epicLabel(e.num), title: e.title, status: epicStatus(e), done: epicDone(e), total: epicTotal(e), dropped: epicDropped(e) })),
    inProgress: liveStories(s).filter(isWip).map(story),
    next: next && story(next),
    loop: run && { status: run.status, ref: run.ref, story: run.currentStory, phase: run.currentPhase, tokensWeighted: run.tokensWeighted },
    alerts: alerts(s),
    open: { deferredWork: openDeferred(s), actionItems: openActionItems(s), reviewFindings: openReviewFindings(s) },
  }
}

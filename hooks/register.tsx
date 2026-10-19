import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { BmadArtifact, BmadEpic, BmadLoopRun, BmadProjectSummary, BmadSnapshot, BmadStory } from '../types'
import { ago, collect, emptySnapshot, findRoot } from './collect'

type $ = EngineInterface

const PANE = 'bmad'
const TITLE = 'BMAD'
const snapshot = atom({ plugin: 'bmad-dashboard', key: 'snapshot' } as const, null)
const tab = atom({ plugin: 'bmad-dashboard', key: 'tab' } as const, 'overview')
const epicSel = atom({ plugin: 'bmad-dashboard', key: 'epic' } as const, 0)
const loading = atom({ plugin: 'bmad-dashboard', key: 'loading' } as const, false)
const projects = atom({ plugin: 'bmad-dashboard', key: 'projects' } as const, [])
const rootSel = atom({ plugin: 'bmad-dashboard', key: 'root' } as const, '')

const TABS = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'sprint', label: 'Sprint', key: '2' },
  { id: 'loop', label: 'Loop', key: '3' },
  { id: 'planning', label: 'Planning', key: '4' },
  { id: 'quality', label: 'Quality', key: '5' },
  { id: 'debt', label: 'Pending', key: '6' },
  { id: 'modules', label: 'Modules', key: '7' },
  { id: 'projects', label: 'Projects', key: '8' },
] as const

// ---------- helpers ----------

function statusColor(s: string | undefined): string | undefined {
  const v = (s ?? '').toLowerCase()
  if (/^(done|final|complete|completed|finished|pass|accepted|approved|built|approve)/.test(v)) return 'success'
  if (/(fail|crash|reject|block|escalat|error|interrupted|not_met)/.test(v)) return 'error'
  if (/(in-progress|in_progress|running|dev-|review-|committing|triage-|building|stopping)/.test(v)) return 'warning'
  if (/(review|concerns|paused|awaiting|waived|deferred|in-review)/.test(v)) return 'suggestion'
  if (/(ready|draft|open)/.test(v)) return 'claude'
  if (/(backlog|optional|pending|not-started|not_started|unknown)/.test(v)) return 'inactive'
  return undefined
}

function bar(done: number, total: number, width: number): string {
  const w = Math.max(4, width)
  const filled = total > 0 ? Math.round((done / total) * w) : 0
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

function pct(done: number, total: number): string {
  return total > 0 ? `${Math.round((done / total) * 100)}%` : '–'
}

function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

function allStories(s: BmadSnapshot): BmadStory[] {
  return s.sprint?.epics.flatMap(e => e.stories) ?? []
}

function epicDone(e: BmadEpic): number {
  return e.stories.filter(x => x.status === 'done').length
}

// sprint-status often leaves an epic at backlog after its stories are done
function epicStatus(e: BmadEpic): string {
  const d = epicDone(e)
  if (e.stories.length && d === e.stories.length) return 'done'
  if (e.stories.some(x => x.status !== 'backlog')) return 'in-progress'
  return e.status
}

function currentEpic(s: BmadSnapshot): BmadEpic | undefined {
  const epics = s.sprint?.epics ?? []
  return epics.find(e => e.stories.some(x => x.status !== 'done')) ?? epics[epics.length - 1]
}

function liveRun(s: BmadSnapshot): BmadLoopRun | undefined {
  return s.loop.runs.find(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused') ?? s.loop.runs[0]
}

type Alert = { level: 'error' | 'warning' | 'suggestion'; text: string }

function alerts(s: BmadSnapshot): Alert[] {
  const out: Alert[] = []
  for (const r of s.loop.runs.slice(0, 3)) {
    if (r.status === 'paused') out.push({ level: 'warning', text: `Loop ${r.ref} paused (${r.pausedStage ?? '?'}): ${r.pausedReason ?? ''}` })
    if (r.status === 'crashed') out.push({ level: 'error', text: `Loop ${r.ref} crashed: ${r.crashError ?? ''}` })
    if (r.pendingDecision) out.push({ level: 'warning', text: `Loop ${r.ref} waiting for a decision: ${r.pendingDecision}` })
    if (r.status === 'running' && r.heartbeatAgeS !== undefined && r.heartbeatAgeS > 90) out.push({ level: 'warning', text: `Loop ${r.ref}: heartbeat stale for ${r.heartbeatAgeS}s` })
    for (const a of r.attention.slice(-2)) if (/CRITICAL|PAUSED/.test(a) && r.status !== 'finished') out.push({ level: 'error', text: a })
  }
  if (s.sprint?.stale) out.push({ level: 'suggestion', text: `sprint-status.yaml out of date (${s.sprint.lastUpdated ?? s.sprint.generated})` })
  const openItems = s.sprint?.actionItems.filter(a => a.status !== 'done').length ?? 0
  if (openItems) out.push({ level: 'suggestion', text: `${openItems} open retrospective action item(s)` })
  const reviewOpen = allStories(s).reduce((n, x) => n + (x.reviewOpen ?? 0), 0)
  if (reviewOpen) out.push({ level: 'warning', text: `${reviewOpen} open code review finding(s)` })
  const failing = s.qualitySummary.gates.filter(g => /fail/i.test(g.status)).length
  if (failing) out.push({ level: 'error', text: `${failing} TEA quality gate(s) FAIL` })
  const blocked = s.buildAuto.byStatus.blocked ?? 0
  if (blocked) out.push({ level: 'warning', text: `${blocked} blocked build-auto result(s)` })
  if (s.changeProposals.length) out.push({ level: 'suggestion', text: `${s.changeProposals.length} sprint change proposal(s)` })
  const openDw = s.deferred.filter(d => d.status !== 'done').length
  if (openDw) out.push({ level: 'suggestion', text: `${openDw} open deferred work item(s)` })
  if (s.inProgressSessions.length) out.push({ level: 'suggestion', text: `${s.inProgressSessions.length} unfinished BMAD session(s) (memlog)` })
  for (const e of s.errors) out.push({ level: 'error', text: e })
  return out
}

function statusLine(s: BmadSnapshot): string | undefined {
  if (!s.found) return undefined
  const parts = [`BMAD ${s.project.name ?? ''}`.trim()]
  const stories = allStories(s)
  if (stories.length) {
    const ep = currentEpic(s)
    if (ep) parts.push(`E${ep.num} ${epicDone(ep)}/${ep.stories.length}`)
    parts.push(`${stories.filter(x => x.status === 'done').length}/${stories.length} stories`)
    const wip = stories.find(x => x.status === 'in-progress' || x.status === 'review')
    if (wip) parts.push(`▸ ${wip.epic}.${wip.num} ${wip.status}`)
  }
  const run = s.loop.runs[0]
  if (run && (run.status === 'running' || run.status === 'paused' || run.status === 'stopping'))
    parts.push(`loop ${run.status === 'running' ? '▶' : '⏸'} ${run.currentStory ? `${run.currentStory.slice(0, 24)} ${run.currentPhase ?? ''}` : run.ref}`.trim())
  return parts.join(' · ')
}

// ---------- collection ----------

let busy = false

async function refresh($: $, options: { statusLine: boolean }) {
  if (busy) return
  busy = true
  try {
    let root = await read($, rootSel)
    if (!root) {
      root = (await findRoot($, await $.session.cwd())) ?? ''
      if (root) await update($, rootSel, () => root)
    }
    if (!root) {
      const cwd = await $.session.cwd()
      await update($, snapshot, () => emptySnapshot(cwd))
      return
    }
    await update($, loading, () => true)
    let snap: BmadSnapshot
    try {
      snap = await collect($, root)
    } catch (err) {
      snap = { ...emptySnapshot(root), found: true, errors: [`collection failed: ${String(err)}`] }
    }
    await update($, snapshot, () => snap)
    await update($, loading, () => false)
    if (options.statusLine) $.ui.status(statusLine(snap))
    await remember($, snap)
  } finally {
    busy = false
  }
}

function summaryOf(s: BmadSnapshot): BmadProjectSummary {
  const stories = allStories(s)
  const wip = stories.find(x => x.status === 'in-progress' || x.status === 'review')
  const run = s.loop.runs[0]
  return {
    root: s.root,
    name: s.project.name,
    lastSeen: Date.now(),
    done: stories.filter(x => x.status === 'done').length,
    total: stories.length,
    inProgress: wip ? `${wip.epic}.${wip.num} ${wip.title ?? ''}`.trim() : undefined,
    loop: run ? `${run.ref} ${run.status}` : undefined,
  }
}

async function remember($: $, s: BmadSnapshot) {
  if (!s.found) return
  const saved = ((await $.store.get('projects')) as BmadProjectSummary[] | undefined) ?? []
  const next = [summaryOf(s), ...saved.filter(p => p.root !== s.root)].slice(0, 40)
  await $.store.set('projects', next)
  await update($, projects, () => next)
}

async function scanProjects($: $, dirs: string[]) {
  const found: string[] = []
  for (const dir of dirs) {
    try {
      const r = await $.process.run(['find', dir, '-maxdepth', '5', '-type', 'd', '-name', '_bmad', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], { timeoutMs: 30000 })
      for (const line of r.stdout.split('\n')) if (line.endsWith('/_bmad')) found.push(line.slice(0, -'/_bmad'.length))
    } catch {
      // a folder we cannot read
    }
  }
  const saved = ((await $.store.get('projects')) as BmadProjectSummary[] | undefined) ?? []
  const known = new Set(saved.map(p => p.root))
  const next = [...saved, ...found.filter(r => !known.has(r)).map(root => ({ root, name: root.split('/').pop(), lastSeen: 0 }))]
  await $.store.set('projects', next)
  await update($, projects, () => next)
  return found.length
}

// ---------- drawing ----------

type El = ReturnType<$['ui']['resolve']>
type Ctx = { el: El; s: BmadSnapshot; cols: number; options: Options }
type Options = { statusLine: boolean; refreshSeconds: number; autoOpen: boolean; scanRoots: string }

function Section(c: Ctx, title: string, children: RenderChildren[]) {
  const { Box, Text } = c.el
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="claude">
        {title}
      </Text>
      {children}
    </Box>
  )
}

function Row(c: Ctx, label: string, value: string | undefined, color?: string) {
  const { Box, Text } = c.el
  if (value === undefined || value === '') return null
  return (
    <Box flexDirection="row">
      <Box width={Math.min(22, Math.floor(c.cols / 3))} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color={color} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  )
}

function Chips(c: Ctx, counts: Record<string, number>) {
  const { Box, Text } = c.el
  const entries = Object.entries(counts).filter(([, n]) => n > 0)
  if (!entries.length) return null
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {entries.map(([k, n]) => (
        <Text color={statusColor(k)}>
          {k} {n}
        </Text>
      ))}
    </Box>
  )
}

function Progress(c: Ctx, label: string, done: number, total: number) {
  const { Box, Text } = c.el
  const w = Math.max(8, Math.min(40, c.cols - 30))
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text>{label}</Text>
      <Text color={done === total && total > 0 ? 'success' : 'claude'}>{bar(done, total, w)}</Text>
      <Text dimColor>
        {done}/{total} {pct(done, total)}
      </Text>
    </Box>
  )
}

function StoryLine(c: Ctx, x: BmadStory) {
  const { Box, Text } = c.el
  const tasks = x.tasksTotal ? ` ${x.tasksDone}/${x.tasksTotal}` : ''
  const review = x.reviewOpen ? ` ⚑${x.reviewOpen}` : ''
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={6} flexShrink={0}>
        <Text dimColor>
          {x.epic}.{x.num}
        </Text>
      </Box>
      <Box width={14} flexShrink={0}>
        <Text color={statusColor(x.status)}>{x.status}</Text>
      </Box>
      <Text wrap="truncate-end">
        {x.title ?? x.key}
        <Text dimColor>{tasks}</Text>
        <Text color="warning">{review}</Text>
      </Text>
    </Box>
  )
}

function ArtifactLine(c: Ctx, a: BmadArtifact) {
  const { Box, Text } = c.el
  const state = (a.verdict ?? a.status ?? (a.steps ? `${a.steps} passos` : '')).split(/[:—;(]/)[0].trim().slice(0, 24)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={16} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {a.kind}
        </Text>
      </Box>
      <Box width={14} flexShrink={0}>
        <Text color={statusColor(state)} wrap="truncate-end">
          {state || '–'}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        {a.title ?? a.path}
        <Text dimColor> {a.updated ?? (a.mtimeMs ? `${ago(Date.now() - a.mtimeMs)} ago` : '')}</Text>
      </Text>
    </Box>
  )
}

function Empty(c: Ctx, text: string) {
  const { Text } = c.el
  return <Text dimColor>{text}</Text>
}

function Overview(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const stories = allStories(s)
  const done = stories.filter(x => x.status === 'done').length
  const ep = currentEpic(s)
  const wip = stories.filter(x => x.status === 'in-progress' || x.status === 'review')
  const next = stories.find(x => x.status === 'ready-for-dev') ?? stories.find(x => x.status === 'backlog')
  const run = liveRun(s)
  const list = alerts(s)
  const git = s.git
  return (
    <Box flexDirection="column">
      <Text bold>
        {s.project.name}
        <Text dimColor>
          {'  '}BMAD {s.project.bmadVersion ?? '?'} · {s.modules.map(m => m.name).join(', ')}
        </Text>
      </Text>
      {git && (
        <Text dimColor wrap="truncate-end">
          ⎇ {git.branch ?? '?'}
          {git.dirty ? ` · ${git.dirty} changed` : ' · clean'}
          {git.ahead ? ` · ↑${git.ahead}` : ''}
          {git.behind ? ` · ↓${git.behind}` : ''}
          {git.lastCommit ? ` · ${git.lastCommit} (${git.lastCommitAgo})` : ''}
        </Text>
      )}
      {s.sprint
        ? Section(c, 'Sprint', [
            Progress(c, 'Total ', done, stories.length),
            ep && Progress(c, `Epic ${ep.num}`, epicDone(ep), ep.stories.length),
            ep?.title && <Text dimColor wrap="truncate-end">{`       ${ep.title}`}</Text>,
            Chips(c, s.sprint.counts),
          ])
        : Section(c, 'Sprint', [Empty(c, 'No sprint-status.yaml (run bmad-sprint-planning).')])}
      {Section(c, 'In progress', wip.length ? wip.map(x => StoryLine(c, x)) : [Empty(c, 'No story in progress.')])}
      {next && Section(c, 'Next', [StoryLine(c, next)])}
      {run &&
        Section(c, 'bmad-loop', [
          <Text wrap="truncate-end">
            <Text color={statusColor(run.status)}>{run.status}</Text> {run.ref}
            {run.currentStory ? ` · ${run.currentStory}` : ''}
            {run.currentPhase ? ` · ${run.currentPhase}` : ''}
            <Text dimColor> · {tokens(run.tokensWeighted)} tok</Text>
          </Text>,
        ])}
      {s.inProgressSessions.length > 0 &&
        Section(
          c,
          'Unfinished sessions',
          s.inProgressSessions.slice(0, 4).map(a => (
            <Text wrap="truncate-end">
              {a.title} <Text dimColor>{a.extra?.last ?? ''}</Text>
            </Text>
          )),
        )}
      {Section(
        c,
        'Alerts',
        list.length
          ? list.slice(0, 10).map(a => (
              <Text color={a.level} wrap="truncate-end">
                • {a.text}
              </Text>
            ))
          : [<Text color="success">Nothing needs attention.</Text>],
      )}
    </Box>
  )
}

function Sprint($: $, c: Ctx, selected: number) {
  const { Box, Text, Button } = c.el
  const { s } = c
  if (!s.sprint) return Empty(c, 'No sprint-status.yaml.')
  const epics = s.sprint.epics
  const ep = epics.find(e => e.num === selected) ?? currentEpic(s)
  const w = Math.max(6, Math.min(20, c.cols - 50))
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {s.sprint.file} · updated {s.sprint.lastUpdated ?? s.sprint.generated ?? '?'}
        {s.sprint.stale ? ' (out of date)' : ''}
      </Text>
      {Section(
        c,
        'Epics',
        epics.map(e => {
          const d = epicDone(e)
          const isSel = e.num === ep?.num
          return (
            <Button key={`epic-${e.num}`} plain onPress={() => update($, epicSel, () => e.num)}>
              <Text color={isSel ? 'claude' : undefined}>{isSel ? '▸' : ' '} </Text>
              <Text>{`E${e.num}`.padEnd(4)}</Text>
              <Text color={d === e.stories.length && e.stories.length ? 'success' : 'claude'}>{bar(d, e.stories.length, w)}</Text>
              <Text dimColor>{` ${d}/${e.stories.length} `}</Text>
              <Text color={statusColor(epicStatus(e))}>{epicStatus(e)}</Text>
              {epicStatus(e) !== e.status && <Text dimColor>{` (yaml: ${e.status})`}</Text>}
              <Text dimColor>
                {e.retro ? ` retro:${e.retro}` : ''}
                {e.retroVerdict ? `(${e.retroVerdict})` : ''} {e.title ?? ''}
              </Text>
            </Button>
          )
        }),
      )}
      {ep &&
        Section(c, `Epic ${ep.num}${ep.title ? `: ${ep.title}` : ''}`, [
          ...ep.stories.map(x => StoryLine(c, x)),
          ep.stories.length === 0 && Empty(c, 'No stories.'),
        ])}
      <Text dimColor>p/n: previous/next epic · click an epic to open it</Text>
    </Box>
  )
}

function Loop(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  if (!s.loop.installed && !s.loop.runs.length) return Empty(c, 'bmad-loop is not installed in this project.')
  if (!s.loop.runs.length) return Empty(c, 'No runs in .bmad-loop/runs.')
  const run = liveRun(s)!
  const others = s.loop.runs.filter(r => r !== run)
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Run {run.ref}</Text> <Text color={statusColor(run.status)}>{run.status}</Text>
        <Text dimColor>
          {' '}
          {run.runType} · {run.source} · started {run.startedAt ?? '?'}
          {run.pid ? ` · pid ${run.pid}` : ''}
        </Text>
      </Text>
      {Row(c, 'Current story', run.currentStory)}
      {Row(c, 'Phase', run.currentPhase, statusColor(run.currentPhase))}
      {Row(c, 'Active session', run.activeTask ? `${run.activeTask}${run.activeRole ? ` (${run.activeRole})` : ''}${run.activeAdapter ? ` · ${run.activeAdapter}` : ''}` : undefined)}
      {Row(c, 'Heartbeat', run.heartbeatAgeS !== undefined ? `${run.heartbeatAgeS}s ago${run.remainingS ? ` · timeout in ${Math.round(run.remainingS / 60)}min` : ''}${run.idle ? ' · idle' : ''}` : undefined)}
      {Row(c, 'Paused', run.pausedReason ? `${run.pausedStage}: ${run.pausedReason}` : undefined, 'warning')}
      {Row(c, 'Pending decision', run.pendingDecision, 'warning')}
      {Row(c, 'Stop requested', run.stopRequested, 'warning')}
      {Row(c, 'Error', run.crashError, 'error')}
      {Row(c, 'Tokens', `${tokens(run.tokensWeighted)} weighted · ${tokens(run.tokensRaw)} raw`)}
      {Section(c, 'Phases', [Chips(c, run.counts)])}
      {Section(
        c,
        'Run stories',
        run.tasks.slice(-12).map(t => (
          <Box flexDirection="row" columnGap={1}>
            <Box width={16} flexShrink={0}>
              <Text color={statusColor(t.phase)}>{t.phase}</Text>
            </Box>
            <Text wrap="truncate-end">
              {t.storyKey}
              <Text dimColor>
                {t.attempt ? ` try ${t.attempt}` : ''}
                {t.reviewCycle ? ` review ${t.reviewCycle}` : ''} · {tokens(t.tokensWeighted)}
                {t.commit ? ` · ${t.commit}` : ''}
                {t.deferReason ? ` · ${t.deferReason}` : ''}
              </Text>
            </Text>
          </Box>
        )),
      )}
      {run.attention.length > 0 &&
        Section(
          c,
          'ATTENTION',
          run.attention.map(a => (
            <Text color="warning" wrap="truncate-end">
              {a}
            </Text>
          )),
        )}
      {Section(
        c,
        'Recent events',
        run.events
          .slice(-12)
          .reverse()
          .map(ev => (
            <Text wrap="truncate-end">
              <Text dimColor>{ev.ts ? clock(ev.ts * 1000) : '--:--:--'} </Text>
              <Text color={statusColor(ev.kind)}>{ev.kind}</Text>
              <Text dimColor>
                {ev.story ? ` ${ev.story}` : ''} {ev.detail ?? ''}
              </Text>
            </Text>
          )),
      )}
      {s.loop.policy &&
        Section(
          c,
          'Policy',
          Object.entries(s.loop.policy).map(([k, v]) => Row(c, k, v)),
        )}
      {others.length > 0 &&
        Section(
          c,
          'Other runs',
          others.map(r => (
            <Text wrap="truncate-end">
              {r.ref} <Text color={statusColor(r.status)}>{r.status}</Text>
              <Text dimColor>
                {' '}
                {r.startedAt} · {Object.entries(r.counts)
                  .map(([k, n]) => `${k} ${n}`)
                  .join(', ')}{' '}
                · {tokens(r.tokensWeighted)} tok
              </Text>
            </Text>
          )),
        )}
    </Box>
  )
}

function Planning(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const isSide = (a: BmadArtifact) => /(^|\/)(reviews?\/|review-|reconcile-|validation-report|addendum|\.?decision-log)/i.test(a.path)
  const main = s.planning.filter(a => !isSide(a))
  const side = s.planning.filter(isSide)
  return (
    <Box flexDirection="column">
      {Section(c, 'Planning artifacts', main.length ? main.slice(0, 30).map(a => ArtifactLine(c, a)) : [Empty(c, 'No artifacts found.')])}
      {side.length > 0 &&
        Section(c, `Reviews, validations and addenda (${side.length})`, side.slice(0, 12).map(a => ArtifactLine(c, a)))}
      {Object.keys(s.workflowStatus).length > 0 &&
        Object.entries(s.workflowStatus).map(([file, st]) =>
          Section(
            c,
            file,
            Object.entries(st).map(([k, v]) => Row(c, k, v, statusColor(v))),
          ),
        )}
      {s.inProgressSessions.length > 0 &&
        Section(
          c,
          'Unfinished sessions (.memlog without status complete)',
          s.inProgressSessions.map(a => (
            <Text wrap="truncate-end">
              {a.path} <Text dimColor>{a.extra?.last ?? ''}</Text>
            </Text>
          )),
        )}
      {s.creative.length > 0 && Section(c, 'Other outputs (brainstorming, forge, party mode, CIS, GDS…)', s.creative.slice(0, 20).map(a => ArtifactLine(c, a)))}
      {s.wds &&
        Section(c, `WDS (${s.wds.root})`, [
          Row(c, 'Backlog', `${s.wds.backlogDone} done · ${s.wds.backlogOpen} open`),
          ...s.wds.current.map(x => Row(c, 'Current', x)),
          ...s.wds.pages.map(p => Row(c, p.page, `${p.status}${p.updated ? ` · ${p.updated}` : ''}`, statusColor(p.status))),
          ...s.wds.deliveries.map(d => Row(c, d.id, `${d.status ?? '?'} ${d.name ?? ''}`, statusColor(d.status))),
        ])}
      {s.orchestrations.length > 0 &&
        Section(
          c,
          'Story Automator',
          s.orchestrations.map(o => Row(c, `epic ${o.epic ?? '?'}`, `${o.status ?? '?'} · ${o.currentStory ?? ''} ${o.currentStep ?? ''} · ${o.completed} sessions done, ${o.active} active`, statusColor(o.status))),
        )}
      {s.other.length > 0 && Section(c, 'Implementation (other)', s.other.slice(0, 10).map(a => ArtifactLine(c, a)))}
    </Box>
  )
}

function Quality(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const q = s.qualitySummary
  const gateCounts: Record<string, number> = {}
  for (const g of q.gates) gateCounts[g.status] = (gateCounts[g.status] ?? 0) + 1
  const scores = q.reviews.filter(r => r.score !== undefined)
  const avg = scores.length ? Math.round(scores.reduce((n, r) => n + (r.score ?? 0), 0) / scores.length) : undefined
  return (
    <Box flexDirection="column">
      {Section(c, 'TEA artifacts', [Object.keys(q.byKind).length ? Chips(c, q.byKind) : Empty(c, 'No artifacts in test-artifacts.')])}
      {q.gates.length > 0 &&
        Section(c, `Quality gates (${q.gates.length})`, [
          Chips(c, gateCounts),
          ...q.gates.slice(0, 15).map(g => (
            <Box flexDirection="row" columnGap={1}>
              <Box width={10} flexShrink={0}>
                <Text color={statusColor(g.status)}>{g.status}</Text>
              </Box>
              <Text wrap="truncate-end">
                {g.target}
                <Text dimColor>
                  {g.coverage ? ` · coverage ${g.coverage}` : ''}
                  {g.criticalOpen ? ` · ${g.criticalOpen} critical` : ''}
                  {g.evaluatedAt ? ` · ${g.evaluatedAt}` : ''}
                </Text>
              </Text>
            </Box>
          )),
        ])}
      {q.reviews.length > 0 &&
        Section(c, `Test reviews${avg !== undefined ? ` (average ${avg}/100)` : ''}`, [
          ...q.reviews.slice(0, 10).map(r => (
            <Text wrap="truncate-end">
              <Text color={r.score !== undefined && r.score >= 80 ? 'success' : r.score !== undefined && r.score < 60 ? 'error' : 'warning'}>
                {r.score !== undefined ? `${r.score}`.padStart(3) : '  ?'}
                {r.grade ? ` ${r.grade}` : ''}
              </Text>{' '}
              {r.target} <Text dimColor>{r.recommendation ?? ''}</Text>
            </Text>
          )),
        ])}
      {q.academy &&
        Section(
          c,
          `TEA Academy${q.academy.user ? ` (${q.academy.user})` : ''}`,
          q.academy.sessions.map(x => Row(c, x.name, `${x.status}${x.score !== undefined ? ` · ${x.score}` : ''}`, statusColor(x.status))),
        )}
      {Section(c, `Build-auto (${s.buildAuto.total} resultados)`, [
        Chips(c, s.buildAuto.byStatus),
        ...s.buildAuto.latest
          .filter(a => a.status !== 'done')
          .slice(0, 8)
          .map(a => (
            <Text wrap="truncate-end">
              <Text color={statusColor(a.status)}>{a.status}</Text> {a.path.replace(/^bmad-build-auto-result-|\.md$/g, '')}
              <Text dimColor> {a.extra?.blocking ?? ''}</Text>
            </Text>
          )),
      ])}
      {s.quality.length > 0 && Section(c, 'Most recent', s.quality.slice(0, 12).map(a => ArtifactLine(c, a)))}
    </Box>
  )
}

function Debt(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const items = s.sprint?.actionItems ?? []
  const openItems = items.filter(a => a.status !== 'done')
  const dwOpen = s.deferred.filter(d => d.status !== 'done')
  const sev: Record<string, number> = {}
  for (const d of dwOpen) sev[d.severity ?? 'no severity'] = (sev[d.severity ?? 'no severity'] ?? 0) + 1
  const reviewStories = allStories(s).filter(x => (x.reviewOpen ?? 0) > 0)
  return (
    <Box flexDirection="column">
      {Section(c, `Action items de retro (${openItems.length} abertos / ${items.length})`, [
        ...openItems.slice(0, 15).map(a => (
          <Text wrap="truncate-end">
            <Text color={statusColor(a.status)}>{a.status}</Text>
            <Text dimColor> E{a.epic ?? '?'} {a.owner ?? ''}</Text> {a.action}
          </Text>
        )),
        items.length === 0 && Empty(c, 'No action items.'),
      ])}
      {Section(c, `Deferred work (${dwOpen.length} abertos / ${s.deferred.length})`, [
        Chips(c, sev),
        ...dwOpen.slice(0, 20).map(d => (
          <Text wrap="truncate-end">
            <Text dimColor>{d.id}</Text> <Text color={/high|critical/i.test(d.severity ?? '') ? 'error' : undefined}>{d.severity ? `[${d.severity}] ` : ''}</Text>
            {d.title}
          </Text>
        )),
        s.deferred.length === 0 && Empty(c, 'No deferred-work.md.'),
      ])}
      {reviewStories.length > 0 && Section(c, 'Open review findings', reviewStories.map(x => StoryLine(c, x)))}
      {s.changeProposals.length > 0 && Section(c, 'Sprint change proposals', s.changeProposals.map(a => ArtifactLine(c, a)))}
      {s.storiesOutsideSprint.length > 0 &&
        Section(c, `Specs fora do sprint (${s.storiesOutsideSprint.length})`, s.storiesOutsideSprint.slice(0, 15).map(x => (
          <Text wrap="truncate-end">
            <Text color={statusColor(x.status)}>{x.status}</Text> {x.title ?? x.key}
            <Text dimColor> {x.type ?? ''}</Text>
          </Text>
        )))}
    </Box>
  )
}

function Modules(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const phases: Record<string, number> = {}
  for (const k of s.skills) phases[k.phase || 'anytime'] = (phases[k.phase || 'anytime'] ?? 0) + 1
  return (
    <Box flexDirection="column">
      {Section(c, 'Project', [
        Row(c, 'Name', s.project.name),
        Row(c, 'User', s.project.user),
        Row(c, 'Language', [s.project.language, s.project.docLanguage].filter(Boolean).join(' / docs: ')),
        Row(c, 'Level', s.project.skillLevel),
        Row(c, 'BMAD', `${s.project.bmadVersion ?? '?'} · installed ${s.project.installDate?.slice(0, 10) ?? '?'} · updated ${s.project.lastUpdated?.slice(0, 10) ?? '?'}`),
        Row(c, 'IDEs', s.project.ides.join(', ')),
      ])}
      {Section(
        c,
        `Modules (${s.modules.length})`,
        s.modules.map(m => Row(c, m.name, `${m.version ?? '?'} · ${m.source ?? ''}${m.channel ? ` · ${m.channel}` : ''}${m.repoUrl ? ` · ${m.repoUrl.replace('https://github.com/', '')}` : ''}`)),
      )}
      {Section(
        c,
        `Agents (${s.agents.length})`,
        s.agents.map(a => (
          <Text wrap="truncate-end">
            {a.icon ?? '•'} <Text bold>{a.name ?? a.code}</Text>
            <Text dimColor>
              {' '}
              {a.title ?? ''} · {a.module ?? ''}
            </Text>
          </Text>
        )),
      )}
      {Section(c, `Skills/workflows (${s.skills.length})`, [Chips(c, phases)])}
      {s.builder.length > 0 &&
        Section(
          c,
          'BMB: built skills',
          s.builder.map(b => Row(c, b.name, `${b.inProgress ? 'building · ' : ''}${b.grade ?? b.verdict ?? 'not analyzed'}${b.analyzedAt ? ` · ${b.analyzedAt}` : ''}`, statusColor(b.grade))),
        )}
      {s.automatorActive && Section(c, 'Story Automator ativo', Object.entries(s.automatorActive).map(([k, v]) => Row(c, k, v)))}
      {Section(
        c,
        'Paths',
        Object.entries(s.paths).map(([k, v]) => Row(c, k, v.startsWith(s.root) ? v.slice(s.root.length + 1) || '.' : v)),
      )}
      <Text dimColor>
        Collected in {s.ms}ms · {clock(s.at)}
      </Text>
    </Box>
  )
}

function Projects($: $, c: Ctx, list: BmadProjectSummary[]) {
  const { Box, Text, Button } = c.el
  const sorted = [...list].sort((a, b) => b.lastSeen - a.lastSeen)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Button label="Scan for projects" hotkey="s" onPress={() => scanProjects($, scanDirs(c))} />
        <Button label="Session project" hotkey="h" onPress={() => switchRoot($, '', c.options)} />
      </Box>
      <Text dimColor wrap="truncate-end">
        Searching in: {scanDirs(c).join(', ')}
      </Text>
      {Section(
        c,
        `Projects (${sorted.length})`,
        sorted.length
          ? sorted.map(p => (
              <Button key={`p-${p.root}`} plain onPress={() => switchRoot($, p.root, c.options)}>
                <Text color={p.root === c.s.root ? 'claude' : undefined}>{p.root === c.s.root ? '▸ ' : '  '}</Text>
                <Text bold>{p.name ?? p.root}</Text>
                <Text dimColor>
                  {p.total ? ` ${p.done}/${p.total}` : ''}
                  {p.inProgress ? ` · ${p.inProgress}` : ''}
                  {p.loop ? ` · loop ${p.loop}` : ''}
                  {p.lastSeen ? ` · seen ${ago(Date.now() - p.lastSeen)} ago` : ''}
                </Text>
              </Button>
            ))
          : [Empty(c, 'No projects yet. Use "Scan for projects".')],
      )}
    </Box>
  )
}

function scanDirs(c: Ctx): string[] {
  const configured = c.options.scanRoots
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
  if (configured.length) return configured
  const root = c.s.root || ''
  const parts = root.split('/')
  return [parts.slice(0, Math.max(2, parts.length - 2)).join('/') || root]
}

async function switchRoot($: $, root: string, options: Options) {
  await update($, rootSel, () => root)
  await update($, tab, () => 'overview')
  await update($, epicSel, () => 0)
  await refresh($, options)
}

// ---------- the module ----------

export const register: Register = (on, rawOptions) => {
  const options: Options = {
    statusLine: rawOptions.statusLine !== false,
    refreshSeconds: Math.max(3, Number(rawOptions.refreshSeconds ?? 15) || 15),
    autoOpen: rawOptions.autoOpen !== false,
    scanRoots: String(rawOptions.scanRoots ?? ''),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bmad-dashboard',
      description: 'BMAD panel: sprint progress, stories, bmad-loop, TEA and more',
      argumentHint: '[refresh|close|scan|<tab>]',
    })
    await $.tool.register({
      name: 'status',
      description:
        'Snapshot of the BMAD project in the working directory, read from disk: installed modules and agents, sprint-status (epics, stories with status and task progress, review findings, retros, action items), planning artifacts (brief, PRD, UX, architecture, epics, research) with their status, TEA quality gates and test reviews, deferred work, bmad-loop runs (live status, current story and phase, tokens, recent journal events), WDS/automator/BMB state and git. Pass `section` to get one part only.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['all', 'project', 'sprint', 'loop', 'planning', 'quality', 'debt', 'modules', 'alerts'],
            description: 'Which part of the snapshot to return (default all).',
          },
        },
      },
    })
    const saved = (await $.store.get('projects')) as BmadProjectSummary[] | undefined
    if (saved) await update($, projects, () => saved)
    await refresh($, options)
    const s = await read($, snapshot)
    if (options.autoOpen && s?.found) void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(options.refreshSeconds * 1000, () => {
      void (async () => {
        const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
        if (isOpen || options.statusLine) await refresh($, options)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'bmad-dashboard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'BMAD panel closed.' }
    }
    if (arg === 'scan') {
      const s = await read($, snapshot)
      const n = await scanProjects($, options.scanRoots ? options.scanRoots.split(',').map(x => x.trim()) : [s?.root.split('/').slice(0, -2).join('/') || (await $.session.cwd())])
      return { text: `${n} BMAD project(s) found.` }
    }
    const t = TABS.find(x => x.id === arg || x.label.toLowerCase() === arg || x.key === arg)
    if (t) await update($, tab, () => t.id)
    await refresh($, options)
    let s = await read($, snapshot)
    // outside a BMAD project the pane still opens, on the projects list
    if (!s?.found && !t) await update($, tab, () => 'projects')
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    s = await read($, snapshot)
    if (!s?.found) return { text: 'No BMAD project (_bmad/) in this directory. The panel opened on the Projects tab: press s to scan for projects.' }
    return { text: opened.isPlaced ? `BMAD panel opened: ${statusLine(s) ?? ''}` : `BMAD panel waiting for room on screen (${opened.reason ?? ''}).` }
  })

  on('tool.call', { tool: 'mcp__bmad-dashboard__status' }, async ($, e) => {
    await refresh($, options)
    const s = await read($, snapshot)
    if (!s?.found) return { result: 'No BMAD project (_bmad/) found from the working directory.' }
    const section = String((e as { input?: { section?: string } }).input?.section ?? (e as { section?: string }).section ?? 'all')
    const pick: Record<string, unknown> = {
      all: s,
      project: { project: s.project, modules: s.modules, agents: s.agents, git: s.git, paths: s.paths },
      sprint: { sprint: s.sprint, storiesOutsideSprint: s.storiesOutsideSprint },
      loop: s.loop,
      planning: { planning: s.planning, workflowStatus: s.workflowStatus, inProgressSessions: s.inProgressSessions, creative: s.creative, wds: s.wds, orchestrations: s.orchestrations },
      quality: { summary: s.qualitySummary, buildAuto: s.buildAuto, recent: s.quality.slice(0, 40) },
      debt: { deferred: s.deferred, actionItems: s.sprint?.actionItems, changeProposals: s.changeProposals },
      modules: { modules: s.modules, agents: s.agents, skills: s.skills, builder: s.builder },
      alerts: alerts(s),
    }
    return { result: JSON.stringify(pick[section] ?? s, null, 1) }
  }).catch(() => ({ result: 'bmad-dashboard could not read the BMAD project.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const s = await read($, snapshot)
    const current = await read($, tab)
    const cols = Math.max(30, Number((e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80))
    const isLoading = await read($, loading)
    if (!s) return <Text dimColor>Loading BMAD…</Text>
    const c: Ctx = { el, s, cols, options }
    const list = await read($, projects)

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TABS.map(t => (
          <Button key={`tab-${t.id}`} plain hotkey={t.key} onPress={() => update($, tab, () => t.id)}>
            <Text color={current === t.id ? 'claude' : undefined} bold={current === t.id} dimColor={current !== t.id}>
              {t.label}
            </Text>
          </Button>
        ))}
        <Button key="refresh" plain hotkey="r" onPress={() => refresh($, options)}>
          <Text dimColor>{isLoading ? '…' : '↻'}</Text>
        </Button>
        {current === 'sprint' && (
          <Button key="prev-epic" plain hotkey="p" onPress={() => stepEpic($, s, -1)}>
            <Text dimColor>◂</Text>
          </Button>
        )}
        {current === 'sprint' && (
          <Button key="next-epic" plain hotkey="n" onPress={() => stepEpic($, s, 1)}>
            <Text dimColor>▸</Text>
          </Button>
        )}
      </Box>
    )

    if (!s.found && current !== 'projects')
      return (
        <Box flexDirection="column">
          {tabs}
          <Text>No BMAD project here.</Text>
          <Text dimColor>Looked for _bmad/ from {s.root}. Open tab 8 to pick another project.</Text>
        </Box>
      )

    let body: RenderChildren
    if (current === 'sprint') body = Sprint($, c, await read($, epicSel))
    else if (current === 'loop') body = Loop(c)
    else if (current === 'planning') body = Planning(c)
    else if (current === 'quality') body = Quality(c)
    else if (current === 'debt') body = Debt(c)
    else if (current === 'modules') body = Modules(c)
    else if (current === 'projects') body = Projects($, c, list)
    else body = Overview(c)

    return (
      <Box flexDirection="column">
        {tabs}
        <Box flexDirection="column" marginTop={1}>
          {body}
        </Box>
      </Box>
    )
  })
}

async function stepEpic($: $, s: BmadSnapshot, dir: number) {
  const epics = s.sprint?.epics ?? []
  if (!epics.length) return
  const cur = (await read($, epicSel)) || currentEpic(s)?.num || epics[0].num
  const i = Math.max(0, epics.findIndex(e => e.num === cur))
  const next = epics[Math.min(epics.length - 1, Math.max(0, i + dir))]
  await update($, epicSel, () => next.num)
}

// The eight tabs of the pane. They only draw: what they need from the module (scan, switch
// project, pick an epic) comes in through `Ctx.actions`.
import type { EngineInterface, RenderChildren } from 'claude-code'

import type { BmadArtifact, BmadProjectSummary, BmadScanResult, BmadSnapshot, BmadStory } from '../types'
import { ago } from './collect'
import { alerts, bar, currentEpic, epicDone, epicDropped, epicHeading, epicLabel, epicLive, epicStatus, epicTotal, isDropped, isWip, liveRun, liveStories, nextStory, pct, progress, scanDirsFor, scanText, statusColor, storyRef, tokens, version } from './derive'

function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

type El = ReturnType<EngineInterface['ui']['resolve']>
// what the tabs can ask of the module without importing it
export type Actions = { scan: (dirs: string[]) => void; switchRoot: (root: string) => void; selectEpic: (num: number) => void }
export type Ctx = { el: El; s: BmadSnapshot; cols: number; options: Options; scan: { running: boolean; result?: BmadScanResult }; actions: Actions }
export type Options = { statusLine: boolean; refreshSeconds: number; autoOpen: boolean; scanRoots: string }

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

function StoryLine(c: Ctx, x: BmadStory, dim = false) {
  const { Box, Text } = c.el
  const tasks = x.tasksTotal ? ` ${x.tasksDone}/${x.tasksTotal}` : ''
  const review = x.reviewOpen ? ` ⚑${x.reviewOpen}` : ''
  // risk and blockedReason come from v7 tickets only, so v6 rows stay as they were
  const note = x.risk || x.blockedReason ? [x.type, x.risk && `risk ${x.risk}`, x.blockedReason && `blocked: ${x.blockedReason}`].filter(Boolean).join(' · ') : ''
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={6} flexShrink={0}>
        <Text dimColor>
          {storyRef(x)}
        </Text>
      </Box>
      <Box width={14} flexShrink={0}>
        <Text color={statusColor(x.status)}>{x.status}</Text>
      </Box>
      <Text wrap="truncate-end" dimColor={dim}>
        {x.title ?? x.key}
        <Text dimColor>{tasks}</Text>
        <Text color="warning">{review}</Text>
        <Text dimColor>{note ? ` · ${note}` : ''}</Text>
      </Text>
    </Box>
  )
}

function ArtifactLine(c: Ctx, a: BmadArtifact) {
  const { Box, Text } = c.el
  const state = (a.verdict ?? a.status ?? (a.steps ? `${a.steps} steps` : '')).split(/[:—;(]/)[0].trim().slice(0, 24)
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

// The first `max` rows of a list, then a dim "+K more" line when the rest is left out.
// `tail` keeps the last `max` instead and puts "+K earlier" above them.
function Capped<T>(c: Ctx, items: readonly T[], max: number, row: (x: T) => RenderChildren, tail = false): RenderChildren[] {
  const { Text } = c.el
  const hidden = items.length - max
  if (hidden <= 0) return items.map(row)
  if (tail) return [<Text dimColor>{`+${hidden} earlier`}</Text>, ...items.slice(-max).map(row)]
  return [...items.slice(0, max).map(row), <Text dimColor>{`+${hidden} more`}</Text>]
}

function noSprint(s: BmadSnapshot, detail: boolean): string {
  if (s.sprintNote) return s.sprintNote
  if (s.project.layout === 'v7') return 'No tickets for the active initiative.'
  return detail ? 'No sprint-status.yaml (run bmad-sprint-planning).' : 'No sprint-status.yaml.'
}

export function Overview(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const { done, total } = progress(s)
  const ep = currentEpic(s)
  const wip = liveStories(s).filter(isWip)
  const next = nextStory(s)
  const run = liveRun(s)
  const list = alerts(s)
  const git = s.git
  return (
    <Box flexDirection="column">
      <Text bold>
        {s.project.name}
        <Text dimColor>
          {'  '}BMAD {version(s)} · {s.modules.map(m => m.name).join(', ')}
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
            Progress(c, 'Total ', done, total),
            ep && Progress(c, epicLabel(ep.num, 'Epic '), epicDone(ep), epicTotal(ep)),
            ep?.title && epicLabel(ep.num) !== 'backlog' && <Text dimColor wrap="truncate-end">{`       ${ep.title}`}</Text>,
            Chips(c, s.sprint.counts),
          ])
        : Section(c, 'Sprint', [Empty(c, noSprint(s, true))])}
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
          Capped(c, s.inProgressSessions, 4, a => (
            <Text wrap="truncate-end">
              {a.title} <Text dimColor>{a.extra?.last ?? ''}</Text>
            </Text>
          )),
        )}
      {Section(
        c,
        'Alerts',
        list.length
          ? Capped(c, list, 10, a => (
              <Text color={a.level} wrap="truncate-end">
                • {a.text}
              </Text>
            ))
          : [<Text color="success">Nothing needs attention.</Text>],
      )}
    </Box>
  )
}

export function Sprint(c: Ctx, selected: number) {
  const { Box, Text, Button } = c.el
  const { s } = c
  if (!s.sprint) return Empty(c, noSprint(s, false))
  const epics = s.sprint.epics
  const ep = epics.find(e => e.num === selected) ?? currentEpic(s)
  const w = Math.max(6, Math.min(20, c.cols - 50))
  const labelWidth = Math.max(4, ...epics.map(e => epicLabel(e.num).length))
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
          const total = epicTotal(e)
          const dropped = epicDropped(e)
          const isSel = e.num === ep?.num
          return (
            <Button key={`epic-${e.num}`} plain onPress={() => c.actions.selectEpic(e.num)}>
              <Text color={isSel ? 'claude' : undefined}>{isSel ? '▸' : ' '} </Text>
              <Text>{epicLabel(e.num).padEnd(labelWidth)}</Text>
              <Text color={d === total && total ? 'success' : 'claude'}>{bar(d, total, w)}</Text>
              <Text dimColor>{` ${d}/${total} `}</Text>
              <Text color={statusColor(epicStatus(e))}>{epicStatus(e)}</Text>
              {epicStatus(e) !== e.status && <Text dimColor>{` (yaml: ${e.status})`}</Text>}
              {dropped > 0 && <Text dimColor>{` ${dropped} dropped`}</Text>}
              <Text dimColor>
                {e.retro ? ` retro:${e.retro}` : ''}
                {e.retroVerdict ? `(${e.retroVerdict})` : ''} {e.title ?? ''}
              </Text>
            </Button>
          )
        }),
      )}
      {ep &&
        Section(c, epicHeading(ep), [
          ...epicLive(ep).map(x => StoryLine(c, x)),
          // dropped stories stay in the list, dimmed, after the live ones
          ...ep.stories.filter(x => !epicLive(ep).includes(x)).map(x => StoryLine(c, x, true)),
          ep.stories.length === 0 && Empty(c, 'No stories.'),
        ])}
      <Text dimColor>p/n: previous/next epic · click an epic to open it</Text>
    </Box>
  )
}

export function Loop(c: Ctx) {
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
        Capped(c, run.tasks, 12, t => (
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
        ), true),
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
        Capped(c, [...run.events].reverse(), 12, ev => (
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

export function Planning(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const isSide = (a: BmadArtifact) => /(^|\/)(reviews?\/|review-|reconcile-|validation-report|addendum|\.?decision-log)/i.test(a.path)
  const main = s.planning.filter(a => !isSide(a))
  const side = s.planning.filter(isSide)
  return (
    <Box flexDirection="column">
      {Section(c, 'Planning artifacts', main.length ? Capped(c, main, 30, a => ArtifactLine(c, a)) : [Empty(c, 'No artifacts found.')])}
      {side.length > 0 &&
        Section(c, `Reviews, validations and addenda (${side.length})`, Capped(c, side, 12, a => ArtifactLine(c, a)))}
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
      {s.creative.length > 0 && Section(c, 'Other outputs (brainstorming, forge, party mode, CIS, GDS…)', Capped(c, s.creative, 20, a => ArtifactLine(c, a)))}
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
      {s.other.length > 0 && Section(c, 'Implementation (other)', Capped(c, s.other, 10, a => ArtifactLine(c, a)))}
    </Box>
  )
}

export function Quality(c: Ctx) {
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
          ...Capped(c, q.gates, 15, g => (
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
          ...Capped(c, q.reviews, 10, r => (
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
      {Section(c, `Build-auto (${s.buildAuto.total} results)`, [
        Chips(c, s.buildAuto.byStatus),
        ...Capped(
          c,
          s.buildAuto.latest.filter(a => a.status !== 'done'),
          8,
          a => (
            <Text wrap="truncate-end">
              <Text color={statusColor(a.status)}>{a.status}</Text> {a.path.replace(/^bmad-build-auto-result-|\.md$/g, '')}
              <Text dimColor> {a.extra?.blocking ?? ''}</Text>
            </Text>
          ),
        ),
      ])}
      {s.quality.length > 0 && Section(c, 'Most recent', Capped(c, s.quality, 12, a => ArtifactLine(c, a)))}
    </Box>
  )
}

export function Debt(c: Ctx) {
  const { Box, Text } = c.el
  const { s } = c
  const items = s.sprint?.actionItems ?? []
  const openItems = items.filter(a => a.status !== 'done')
  const dwOpen = s.deferred.filter(d => d.status !== 'done')
  const sev: Record<string, number> = {}
  for (const d of dwOpen) sev[d.severity ?? 'no severity'] = (sev[d.severity ?? 'no severity'] ?? 0) + 1
  const reviewStories = liveStories(s).filter(x => (x.reviewOpen ?? 0) > 0)
  const outside = s.storiesOutsideSprint.filter(x => !isDropped(x.status))
  return (
    <Box flexDirection="column">
      {Section(c, `Retro action items (${openItems.length} open / ${items.length})`, [
        ...Capped(c, openItems, 15, a => (
          <Text wrap="truncate-end">
            <Text color={statusColor(a.status)}>{a.status}</Text>
            <Text dimColor> E{a.epic ?? '?'} {a.owner ?? ''}</Text> {a.action}
          </Text>
        )),
        items.length === 0 && Empty(c, 'No action items.'),
      ])}
      {Section(c, `Deferred work (${dwOpen.length} open / ${s.deferred.length})`, [
        Chips(c, sev),
        ...Capped(c, dwOpen, 20, d => (
          <Text wrap="truncate-end">
            <Text dimColor>{d.id}</Text> <Text color={/high|critical/i.test(d.severity ?? '') ? 'error' : undefined}>{d.severity ? `[${d.severity}] ` : ''}</Text>
            {d.title}
          </Text>
        )),
        s.deferred.length === 0 && Empty(c, 'No deferred-work.md.'),
      ])}
      {reviewStories.length > 0 && Section(c, 'Open review findings', reviewStories.map(x => StoryLine(c, x)))}
      {s.changeProposals.length > 0 && Section(c, 'Sprint change proposals', s.changeProposals.map(a => ArtifactLine(c, a)))}
      {outside.length > 0 &&
        Section(c, `Specs outside the sprint (${outside.length})`, Capped(c, outside, 15, x => (
          <Text wrap="truncate-end">
            <Text color={statusColor(x.status)}>{x.status}</Text> {x.title ?? x.key}
            <Text dimColor> {x.type ?? ''}</Text>
          </Text>
        )))}
    </Box>
  )
}

export function Modules(c: Ctx) {
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
        Row(c, 'BMAD', `${version(s)} · installed ${s.project.installDate?.slice(0, 10) ?? '?'} · updated ${s.project.lastUpdated?.slice(0, 10) ?? '?'}`),
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
      {s.automatorActive && Section(c, 'Story Automator active', Object.entries(s.automatorActive).map(([k, v]) => Row(c, k, v)))}
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

export function Projects(c: Ctx, list: BmadProjectSummary[]) {
  const { Box, Text, Button } = c.el
  const sorted = [...list].sort((a, b) => b.lastSeen - a.lastSeen)
  const dirs = scanDirsFor(c.options.scanRoots, c.s.root)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Button key="scan" label="Scan for projects" hotkey="s" onPress={() => c.actions.scan(dirs)} />
        <Button key="session-project" label="Session project" hotkey="h" onPress={() => c.actions.switchRoot('')} />
      </Box>
      <Text dimColor wrap="truncate-end">
        Searching in: {dirs.join(', ')}
      </Text>
      {c.scan.running && <Text color="warning">Scanning…</Text>}
      {!c.scan.running && c.scan.result && <Text color="success">{`Scan: ${scanText(c.scan.result)}`}</Text>}
      {Section(
        c,
        `Projects (${sorted.length})`,
        sorted.length
          ? sorted.map(p => (
              <Button key={`p-${p.root}`} plain onPress={() => c.actions.switchRoot(p.root)}>
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


import { describe, expect, test } from 'claude-code/testing'

import type { BmadEpic, BmadLoopRun, BmadProjectSummary, BmadSnapshot, BmadStory } from '../types'
import { BACKLOG_EPIC, emptySnapshot } from '../hooks/collect'
import {
  MAX_PROJECTS,
  SEEN_REFRESH_MS,
  alerts,
  capProjects,
  currentEpic,
  epicDone,
  epicDropped,
  epicLive,
  epicTotal,
  isClosed,
  isDropped,
  liveStories,
  progress,
  epicHeading,
  epicLabel,
  epicStatus,
  liveRun,
  nextStory,
  scanDirsFor,
  scanText,
  shouldStore,
  statusColor,
  statusLine,
  storyRef,
  summaryChanged,
  summaryOf,
  toolSummary,
} from '../hooks/derive'

const story = (epic: number, num: string, status: string, extra: Partial<BmadStory> = {}): BmadStory => ({ key: `${epic}.${num}`, epic, num, status, ...extra })
const epic = (num: number, statuses: string[], extra: Partial<BmadEpic> = {}): BmadEpic => ({ num, status: 'backlog', stories: statuses.map((st, i) => story(num, String(i + 1), st)), ...extra })
const run = (extra: Partial<BmadLoopRun> = {}): BmadLoopRun => ({ runId: 'r1', ref: 'r1', status: 'finished', tokensRaw: 0, tokensWeighted: 0, attention: [], tasks: [], events: [], counts: {}, ...extra })

function snap(extra: Partial<BmadSnapshot> = {}, epics?: BmadEpic[]): BmadSnapshot {
  const s: BmadSnapshot = { ...emptySnapshot('/work/demo'), found: true, project: { name: 'demo', ides: [] }, ...extra }
  if (epics) s.sprint = { file: 'sprint-status.yaml', stale: false, counts: {}, epics, actionItems: [] }
  return s
}

describe('statusColor', () => {
  test('the statuses the panel uses', () => {
    const cases: [string | undefined, string | undefined][] = [
      ['done', 'success'],
      ['FAIL', 'error'],
      ['pass', 'success'],
      ['crashed', 'error'],
      ['blocked', 'error'],
      ['in-progress', 'warning'],
      ['running', 'warning'],
      ['dev-running', 'warning'],
      ['review', 'suggestion'],
      ['paused', 'suggestion'],
      ['ready-for-dev', 'claude'],
      ['open', 'claude'],
      ['backlog', 'inactive'],
      ['optional', 'inactive'],
      ['whatever', undefined],
      [undefined, undefined],
    ]
    for (const [status, color] of cases) expect(statusColor(status)).toBe(color)
  })
})

describe('epics', () => {
  test('epicStatus: all done wins over a stale yaml status', () => {
    expect(epicStatus(epic(1, ['done', 'done']))).toBe('done')
  })
  test('epicStatus: a mix is in progress', () => {
    expect(epicStatus(epic(1, ['done', 'backlog']))).toBe('in-progress')
    expect(epicStatus(epic(1, ['review', 'backlog']))).toBe('in-progress')
  })
  test('epicStatus: all backlog keeps the yaml status', () => {
    expect(epicStatus(epic(1, ['backlog', 'backlog'], { status: 'backlog' }))).toBe('backlog')
    expect(epicStatus(epic(1, [], { status: 'optional' }))).toBe('optional')
  })
  test('epicDone counts done stories', () => {
    expect(epicDone(epic(1, ['done', 'review', 'done']))).toBe(2)
  })

  test('currentEpic is the first epic with an open story, else the last', () => {
    const s = snap({}, [epic(1, ['done']), epic(2, ['done', 'backlog']), epic(3, ['backlog'])])
    expect(currentEpic(s)?.num).toBe(2)
    expect(currentEpic(snap({}, [epic(1, ['done']), epic(2, ['done'])]))?.num).toBe(2)
    expect(currentEpic(snap())).toBeUndefined()
  })

  test('the backlog epic is labelled backlog, never 999', () => {
    expect(epicLabel(3)).toBe('E3')
    expect(epicLabel(3, 'Epic ')).toBe('Epic 3')
    expect(epicLabel(BACKLOG_EPIC)).toBe('backlog')
    expect(epicLabel(BACKLOG_EPIC, 'Epic ')).toBe('backlog')
    expect(epicHeading(epic(2, [], { title: 'Auth' }))).toBe('Epic 2: Auth')
    expect(epicHeading(epic(2, []))).toBe('Epic 2')
    expect(epicHeading(epic(BACKLOG_EPIC, [], { title: 'backlog' }))).toBe('Backlog')
    expect(storyRef(story(1, '2', 'done'))).toBe('1.2')
    expect(storyRef(story(BACKLOG_EPIC, '', 'done'))).toBe('')
    expect(storyRef(story(BACKLOG_EPIC, '7', 'done'))).toBe('7')
  })

  test('nextStory prefers ready-for-dev, then backlog', () => {
    expect(nextStory(snap({}, [epic(1, ['done', 'backlog', 'ready-for-dev'])]))?.num).toBe('3')
    expect(nextStory(snap({}, [epic(1, ['done', 'backlog'])]))?.num).toBe('2')
    expect(nextStory(snap({}, [epic(1, ['done'])]))).toBeUndefined()
  })
})

describe('liveRun', () => {
  test('a running, stopping or paused run wins over the newest one', () => {
    const s = snap({ loop: { installed: true, runs: [run({ ref: 'new', status: 'finished' }), run({ ref: 'live', status: 'running' })] } })
    expect(liveRun(s)?.ref).toBe('live')
    for (const status of ['stopping', 'paused']) expect(liveRun(snap({ loop: { installed: true, runs: [run({ ref: 'x' }), run({ ref: 'y', status })] } }))?.ref).toBe('y')
  })
  test('with none live it is the first run, and none gives undefined', () => {
    expect(liveRun(snap({ loop: { installed: true, runs: [run({ ref: 'a' }), run({ ref: 'b' })] } }))?.ref).toBe('a')
    expect(liveRun(snap())).toBeUndefined()
  })
})

describe('alerts', () => {
  const texts = (s: BmadSnapshot) => alerts(s).map(a => `${a.level}: ${a.text}`)

  test('nothing to report gives no alerts', () => {
    expect(alerts(snap())).toEqual([])
  })
  test('paused run', () => {
    expect(texts(snap({ loop: { installed: true, runs: [run({ ref: 'r9', status: 'paused', pausedStage: 'review', pausedReason: 'needs a human' })] } }))).toEqual(['warning: Loop r9 paused (review): needs a human'])
  })
  test('crashed run', () => {
    expect(texts(snap({ loop: { installed: true, runs: [run({ ref: 'r9', status: 'crashed', crashError: 'boom' })] } }))).toEqual(['error: Loop r9 crashed: boom'])
  })
  test('pending decision', () => {
    expect(texts(snap({ loop: { installed: true, runs: [run({ ref: 'r9', status: 'running', pendingDecision: 'merge?' })] } }))).toEqual(['warning: Loop r9 waiting for a decision: merge?'])
  })
  test('stale heartbeat only while running and past 90s', () => {
    const at = (status: string, heartbeatAgeS: number) => texts(snap({ loop: { installed: true, runs: [run({ ref: 'r9', status, heartbeatAgeS })] } }))
    expect(at('running', 120)).toEqual(['warning: Loop r9: heartbeat stale for 120s'])
    expect(at('running', 90)).toEqual([])
    expect(at('finished', 500)).toEqual([])
  })
  test('CRITICAL or PAUSED attention lines, unless the run finished', () => {
    const attention = ['old', 'CRITICAL: disk', 'all fine']
    expect(texts(snap({ loop: { installed: true, runs: [run({ status: 'running', attention })] } }))).toEqual(['error: CRITICAL: disk'])
    expect(texts(snap({ loop: { installed: true, runs: [run({ status: 'finished', attention })] } }))).toEqual([])
  })
  test('only the three newest runs are looked at', () => {
    const runs = [1, 2, 3, 4].map(i => run({ ref: `r${i}`, status: 'crashed', crashError: 'x' }))
    expect(alerts(snap({ loop: { installed: true, runs } }))).toHaveLength(3)
  })
  test('stale sprint file', () => {
    const s = snap({}, [epic(1, ['done'])])
    s.sprint!.stale = true
    s.sprint!.lastUpdated = '10-18-2026'
    expect(texts(s)).toEqual(['suggestion: sprint-status.yaml out of date (10-18-2026)'])
  })
  test('open retro action items', () => {
    const s = snap({}, [])
    s.sprint!.actionItems = [
      { action: 'a', status: 'open' },
      { action: 'b', status: 'done' },
    ]
    expect(texts(s)).toEqual(['suggestion: 1 open retrospective action item(s)'])
  })
  test('open review findings', () => {
    const s = snap({}, [{ ...epic(1, []), stories: [story(1, '1', 'review', { reviewOpen: 2 }), story(1, '2', 'review', { reviewOpen: 1 })] }])
    expect(texts(s)).toEqual(['warning: 3 open code review finding(s)'])
  })
  test('failing quality gates', () => {
    const s = snap()
    s.qualitySummary.gates = [
      { target: 'a', status: 'FAIL', file: 'a.json' },
      { target: 'b', status: 'PASS', file: 'b.json' },
    ]
    expect(texts(s)).toEqual(['error: 1 TEA quality gate(s) FAIL'])
  })
  test('blocked build-auto results', () => {
    expect(texts(snap({ buildAuto: { total: 3, byStatus: { blocked: 2, done: 1 }, latest: [] } }))).toEqual(['warning: 2 blocked build-auto result(s)'])
  })
  test('change proposals, deferred work and unfinished sessions', () => {
    const art = { path: 'p.md', kind: 'doc', mtimeMs: 0 }
    expect(texts(snap({ changeProposals: [art] }))).toEqual(['suggestion: 1 sprint change proposal(s)'])
    expect(texts(snap({ deferred: [{ id: 'DW-1', title: 't', status: 'open' }, { id: 'DW-2', title: 't', status: 'done' }] }))).toEqual(['suggestion: 1 open deferred work item(s)'])
    expect(texts(snap({ inProgressSessions: [art, art] }))).toEqual(['suggestion: 2 unfinished BMAD session(s) (memlog)'])
  })
  test('collection errors come last, as errors', () => {
    const s = snap({ errors: ['tickets.py failed'], deferred: [{ id: 'DW-1', title: 't', status: 'open' }] })
    expect(texts(s)).toEqual(['suggestion: 1 open deferred work item(s)', 'error: tickets.py failed'])
  })
})

describe('statusLine', () => {
  test('nothing for a project that was not found', () => {
    expect(statusLine({ ...snap(), found: false })).toBeUndefined()
  })
  test('name only without a sprint', () => {
    expect(statusLine(snap())).toBe('BMAD demo')
  })
  test('epic, totals and the story in progress', () => {
    const s = snap({}, [epic(1, ['done', 'done']), epic(2, ['done', 'in-progress', 'backlog'])])
    expect(statusLine(s)).toBe('BMAD demo · E2 1/3 · 3/5 stories · ▸ 2.2 in-progress')
  })
  test('the loop part follows liveRun, not the newest run', () => {
    const s = snap({ loop: { installed: true, runs: [run({ ref: 'old', status: 'finished' }), run({ ref: 'live', status: 'running', currentStory: '1-2-second', currentPhase: 'dev-running' })] } })
    expect(statusLine(s)).toBe('BMAD demo · loop ▶ 1-2-second dev-running')
    expect(statusLine(snap({ loop: { installed: true, runs: [run({ ref: 'old', status: 'finished' })] } }))).toBe('BMAD demo')
    expect(statusLine(snap({ loop: { installed: true, runs: [run({ ref: 'p1', status: 'paused' })] } }))).toBe('BMAD demo · loop ⏸ p1')
  })
  test('the backlog epic reads backlog, not E999', () => {
    const backlog = epic(BACKLOG_EPIC, ['done', 'in-progress'], { title: 'backlog' })
    backlog.stories[1] = story(BACKLOG_EPIC, '', 'in-progress', { key: 'story-b.md' })
    const line = statusLine(snap({}, [backlog]))!
    expect(line).toBe('BMAD demo · backlog 1/2 · 1/2 stories · ▸ story-b.md in-progress')
    expect(line).not.toContain('999')
  })
})

describe('summaryOf', () => {
  test('counts, the story in progress and the live run', () => {
    const s = snap({ loop: { installed: true, runs: [run({ ref: 'old' }), run({ ref: 'live', status: 'running' })] } }, [epic(1, ['done', 'review'])])
    s.sprint!.epics[0]!.stories[1]!.title = 'Second'
    expect(summaryOf(s, 5)).toEqual({ root: '/work/demo', name: 'demo', lastSeen: 5, done: 1, total: 2, inProgress: '1.2 Second', loop: 'live running' })
  })
  test('a backlog story shows no 999', () => {
    const s = snap({}, [{ ...epic(BACKLOG_EPIC, []), stories: [story(BACKLOG_EPIC, '', 'in-progress', { title: 'Loose' })] }])
    expect(summaryOf(s, 1).inProgress).toBe('Loose')
  })
})

describe('project list', () => {
  const p = (root: string, lastSeen: number, extra: Partial<BmadProjectSummary> = {}): BmadProjectSummary => ({ root, name: root, lastSeen, done: 1, total: 2, ...extra })

  test('summaryChanged ignores lastSeen only', () => {
    expect(summaryChanged(p('/a', 1), p('/a', 999))).toBe(false)
    expect(summaryChanged(p('/a', 1), p('/a', 1, { done: 2 }))).toBe(true)
    expect(summaryChanged(p('/a', 1), p('/a', 1, { loop: 'r1 running' }))).toBe(true)
    expect(summaryChanged(p('/a', 1), p('/a', 1, { inProgress: '1.1 x' }))).toBe(true)
  })

  test('shouldStore: new, changed or old', () => {
    expect(shouldStore(undefined, p('/a', 10))).toBe(true)
    expect(shouldStore(p('/a', 10), p('/a', 11))).toBe(false)
    expect(shouldStore(p('/a', 10), p('/a', 11, { done: 2 }))).toBe(true)
    expect(shouldStore(p('/a', 10), p('/a', 10 + SEEN_REFRESH_MS - 1))).toBe(false)
    expect(shouldStore(p('/a', 10), p('/a', 10 + SEEN_REFRESH_MS))).toBe(true)
  })

  test('capProjects keeps the most recently seen', () => {
    expect(MAX_PROJECTS).toBe(200)
    const list = Array.from({ length: 5 }, (_, i) => p(`/p${i}`, i))
    expect(capProjects(list, 10)).toBe(list)
    expect(capProjects(list, 3).map(x => x.root)).toEqual(['/p4', '/p3', '/p2'])
    // scanned, never opened projects (lastSeen 0) go first
    const scanned = [p('/seen', 50), ...Array.from({ length: 4 }, (_, i) => p(`/scan${i}`, 0))]
    expect(capProjects(scanned, 2).map(x => x.root)).toEqual(['/seen', '/scan0'])
  })

  test('scanDirsFor: configured folders without empty entries, else two levels above the project', () => {
    expect(scanDirsFor(' /a , ,/b,', '/work/demo')).toEqual(['/a', '/b'])
    expect(scanDirsFor('', '/home/me/code/proj')).toEqual(['/home/me'])
    expect(scanDirsFor('', '/work/demo')).toEqual(['/work'])
    expect(scanDirsFor(',', '')).toEqual([])
  })

  test('scanText', () => {
    expect(scanText({ found: 12, added: 3, removed: 0 })).toBe('12 found, 3 new')
    expect(scanText({ found: 12, added: 3, removed: 2 })).toBe('12 found, 3 new, 2 removed')
  })
})

describe('toolSummary', () => {
  test('a small object with the parts a model asks about', () => {
    const s = snap(
      {
        project: { name: 'demo', bmadVersion: '6.12.4', layout: 'v6', ides: [] },
        modules: [{ name: 'core' }, { name: 'bmm' }],
        git: { branch: 'main', dirty: 2, ahead: 1, lastCommit: 'abc fix' },
        loop: { installed: true, runs: [run({ ref: 'r1', status: 'running', currentStory: '1-2', currentPhase: 'dev', tokensWeighted: 900 })] },
        deferred: [{ id: 'DW-1', title: 't', status: 'open' }],
      },
      [epic(1, ['done', 'done'], { title: 'Foundation' }), epic(2, ['done', 'review', 'ready-for-dev'], { title: 'Next' }), epic(BACKLOG_EPIC, ['backlog'], { title: 'backlog' })],
    )
    s.sprint!.counts = { done: 3 }
    s.sprint!.actionItems = [{ action: 'x', status: 'open' }]
    s.sprint!.epics[1]!.stories[1]!.reviewOpen = 2
    const out = toolSummary(s)
    expect(out.project).toBe('demo')
    expect(out.bmadVersion).toBe('6.12.4')
    expect(out.layout).toBe('v6')
    expect(out.modules).toEqual(['core', 'bmm'])
    expect(out.git).toEqual({ branch: 'main', dirty: 2, ahead: 1, behind: undefined, lastCommit: 'abc fix' })
    expect(out.epics).toEqual([
      { num: 1, label: 'E1', title: 'Foundation', status: 'done', done: 2, total: 2, dropped: 0 },
      { num: 2, label: 'E2', title: 'Next', status: 'in-progress', done: 1, total: 3, dropped: 0 },
      { num: BACKLOG_EPIC, label: 'backlog', title: 'backlog', status: 'backlog', done: 0, total: 1, dropped: 0 },
    ])
    expect(out.inProgress).toEqual([{ ref: '2.2', title: undefined, status: 'review' }])
    expect(out.next).toEqual({ ref: '2.3', title: undefined, status: 'ready-for-dev' })
    expect(out.loop).toEqual({ status: 'running', ref: 'r1', story: '1-2', phase: 'dev', tokensWeighted: 900 })
    expect(out.open).toEqual({ deferredWork: 1, actionItems: 1, reviewFindings: 2 })
    expect(out.alerts.map(a => a.level)).toContain('warning')
  })

  test('a project without a sprint says why', () => {
    const out = toolSummary(snap({ sprintNote: 'tickets not read' }))
    expect(out.sprint).toBeUndefined()
    expect(out.sprintNote).toBe('tickets not read')
    expect(out.epics).toEqual([])
    expect(out.loop).toBeUndefined()
    expect(out.next).toBeUndefined()
  })
})

describe('dropped work', () => {
  const droppedStory = (epicNum: number, n: string, status = 'dropped', extra: Partial<BmadStory> = {}) => story(epicNum, n, status, extra)
  const mixed = (stories: BmadStory[], status = 'in-progress'): BmadEpic => ({ num: 1, status, stories })

  test('dropped and closed statuses', () => {
    for (const s of ['dropped', 'Dropped', 'DROPPED', 'cancelled', 'canceled', 'Cancelled (scope)']) expect(isDropped(s)).toBe(true)
    for (const s of ['done', 'backlog', 'in-progress', 'not dropped', '', undefined]) expect(isDropped(s)).toBe(false)
    expect(isClosed('done')).toBe(true)
    expect(isClosed('dropped')).toBe(true)
    expect(isClosed('review')).toBe(false)
    expect(isClosed(undefined)).toBe(false)
  })

  test('statusColor is inactive for dropped and cancelled', () => {
    for (const s of ['dropped', 'cancelled', 'canceled', 'Dropped']) expect(statusColor(s)).toBe('inactive')
  })

  test('in a dropped epic the open stories count as dropped, the delivered ones stay', () => {
    const e = mixed([droppedStory(1, '1', 'done'), droppedStory(1, '2', 'backlog')], 'dropped')
    expect(epicLive(e).map(x => x.num)).toEqual(['1'])
    expect(epicTotal(e)).toBe(1)
    expect(epicDropped(e)).toBe(1)
    expect(epicDone(e)).toBe(1)
  })

  test('epicDone and epicTotal leave dropped stories out', () => {
    const e = mixed([story(1, '1', 'done'), droppedStory(1, '2'), story(1, '3', 'backlog')])
    expect(epicDone(e)).toBe(1)
    expect(epicTotal(e)).toBe(2)
    expect(epicDropped(e)).toBe(1)
  })

  test('epicStatus: done when every story that is not dropped is done, and there is one', () => {
    expect(epicStatus(mixed([story(1, '1', 'done'), droppedStory(1, '2'), story(1, '3', 'done')], 'backlog'))).toBe('done')
    expect(epicStatus(mixed([story(1, '1', 'done'), droppedStory(1, '2'), story(1, '3', 'backlog')], 'backlog'))).toBe('in-progress')
  })
  test('epicStatus: dropped when the epic is, or all its stories are', () => {
    expect(epicStatus(mixed([story(1, '1', 'backlog')], 'dropped'))).toBe('dropped')
    expect(epicStatus(mixed([story(1, '1', 'done')], 'Cancelled'))).toBe('dropped')
    expect(epicStatus(mixed([droppedStory(1, '1'), droppedStory(1, '2', 'cancelled')], 'in-progress'))).toBe('dropped')
  })
  test('epicStatus: in progress only for a story that is neither backlog nor dropped', () => {
    expect(epicStatus(mixed([droppedStory(1, '1', 'dropped'), story(1, '2', 'backlog')], 'backlog'))).toBe('backlog')
    expect(epicStatus(mixed([droppedStory(1, '1'), story(1, '2', 'review')], 'backlog'))).toBe('in-progress')
  })

  test('currentEpic skips epics whose leftovers are dropped, and dropped epics', () => {
    const s = snap({}, [
      mixed([story(1, '1', 'done'), droppedStory(1, '2')]),
      { num: 2, status: 'dropped', stories: [story(2, '1', 'backlog')] },
      { num: 3, status: 'backlog', stories: [story(3, '1', 'backlog')] },
    ])
    expect(currentEpic(s)?.num).toBe(3)
  })
  test('currentEpic with nothing left is the last epic that was not dropped', () => {
    const s = snap({}, [mixed([story(1, '1', 'done')]), { num: 2, status: 'dropped', stories: [story(2, '1', 'backlog')] }])
    expect(currentEpic(s)?.num).toBe(1)
    expect(currentEpic(snap({}, [{ num: 4, status: 'dropped', stories: [] }]))?.num).toBe(4)
  })

  test('nextStory skips dropped stories and dropped epics', () => {
    const s = snap({}, [
      { num: 1, status: 'dropped', stories: [story(1, '1', 'backlog'), story(1, '2', 'ready-for-dev')] },
      { num: 2, status: 'in-progress', stories: [droppedStory(2, '1', 'dropped'), story(2, '2', 'backlog')] },
    ])
    expect(nextStory(s)?.key).toBe('2.2')
    expect(nextStory(snap({}, [mixed([droppedStory(1, '1')])]))).toBeUndefined()
  })

  test('progress is delivered work over work that still counts', () => {
    const s = snap({}, [mixed([story(1, '1', 'done'), droppedStory(1, '2'), story(1, '3', 'backlog')]), { num: 2, status: 'dropped', stories: [story(2, '1', 'backlog')] }])
    expect(progress(s)).toEqual({ done: 1, total: 2, dropped: 2 })
    expect(liveStories(s).map(x => x.key)).toEqual(['1.1', '1.3'])
  })

  test('statusLine counts only what still counts, and never lists a dropped story in progress', () => {
    const s = snap({}, [mixed([story(1, '1', 'done'), droppedStory(1, '2', 'in-progress', { status: 'dropped' }), story(1, '3', 'backlog')])])
    expect(statusLine(s)).toBe('BMAD demo · E1 1/2 · 1/2 stories')
    const dropped = snap({}, [{ num: 1, status: 'dropped', stories: [story(1, '1', 'in-progress')] }])
    expect(statusLine(dropped)).toBe('BMAD demo')
  })

  test('summaryOf and toolSummary use the same totals', () => {
    const s = snap({}, [mixed([story(1, '1', 'done'), droppedStory(1, '2'), story(1, '3', 'review')]), { num: 2, status: 'dropped', stories: [story(2, '1', 'backlog')] }])
    expect(summaryOf(s, 1)).toMatchObject({ done: 1, total: 2, inProgress: '1.3' })
    const out = toolSummary(s)
    expect(out.sprint?.dropped).toBe(2)
    expect(out.epics).toEqual([
      { num: 1, label: 'E1', title: undefined, status: 'in-progress', done: 1, total: 2, dropped: 1 },
      { num: 2, label: 'E2', title: undefined, status: 'dropped', done: 0, total: 0, dropped: 1 },
    ])
    expect(out.inProgress.map(x => x.ref)).toEqual(['1.3'])
    expect(out.next).toBeUndefined()
  })

  test('review findings on a dropped story raise no alert', () => {
    const open = snap({}, [mixed([story(1, '1', 'review', { reviewOpen: 2 })])])
    expect(alerts(open).map(a => a.text)).toEqual(['2 open code review finding(s)'])
    const dropped = snap({}, [mixed([droppedStory(1, '1', 'dropped', { reviewOpen: 2 }), story(1, '2', 'done', { reviewOpen: 0 })]), { num: 2, status: 'dropped', stories: [story(2, '1', 'review', { reviewOpen: 3 })] }])
    expect(alerts(dropped)).toEqual([])
  })
})

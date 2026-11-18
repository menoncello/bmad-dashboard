import { describe, expect, test } from 'claude-code/testing'

import { BACKLOG_EPIC, countTasks, parseDeferred, parseEpicTitles, parseSprintDate, planningKind, qualityKind, skillOf, storyNumbers } from '../hooks/collect'
import { isFinishedStatus, statusIs } from '../hooks/modules'
import { FILES, ROOT, V7, V7_TICKET_FILES, fakeProject, status } from './fixture'

describe('status words', () => {
  test('finished means a whole word, not a substring', () => {
    for (const s of ['done', 'Done', 'complete', 'completed', 'final', 'FINAL', 'status: done', 'complete (reviewed)']) expect(isFinishedStatus(s)).toBe(true)
    for (const s of ['incomplete', 'in-progress', 'unfinal', 'not done', 'not-complete', 'undone', 'abandoned', '', undefined]) expect(isFinishedStatus(s)).toBe(false)
  })

  test('negations keep a word from counting', () => {
    expect(statusIs('resolved', ['resolved'])).toBe(true)
    expect(statusIs('unresolved', ['resolved'])).toBe(false)
    expect(statusIs('un-resolved', ['resolved'])).toBe(false)
    expect(statusIs('not resolved yet', ['resolved'])).toBe(false)
  })
})

describe('parseDeferred', () => {
  const block = (status: string) => `### DW-1: thing\n- severity: low\n- status: ${status}\n`

  test('done, resolved and closed are done, as whole words', () => {
    for (const s of ['done', 'Done', 'resolved', 'RESOLVED', 'Resolved in 1-3', 'closed', 'closed (won\'t fix)']) expect(parseDeferred(block(s))[0]?.status).toBe('done')
  })

  test('unresolved, not done and not resolved stay open', () => {
    expect(parseDeferred(block('unresolved'))[0]?.status).toBe('unresolved')
    expect(parseDeferred(block('not done'))[0]?.status).toBe('not-done')
    expect(parseDeferred(block('not resolved'))[0]?.status).toBe('not-resolved')
    expect(parseDeferred(block('open'))[0]?.status).toBe('open')
    for (const s of ['unresolved', 'not done', 'not resolved', 'open', 'in-progress']) expect(parseDeferred(block(s))[0]?.status).not.toBe('done')
  })

  test('a block without status is open, and the fields are read', () => {
    const [d] = parseDeferred('### DW-7: no status here\n- severity: high\n- origin: 1-2\n')
    expect(d).toMatchObject({ id: 'DW-7', title: 'no status here', severity: 'high', status: 'open', origin: '1-2' })
  })

  test('the bullet form marks only whole-word RESOLVED as done', () => {
    const out = parseDeferred('## Deferred from: review\n- first thing\n- second thing RESOLVED in abc\n- third is unresolved\n- fourth is not resolved\n- source_spec: x\n')
    expect(out.map(d => d.status)).toEqual(['open', 'done', 'open', 'open'])
    expect(out.map(d => d.id)).toEqual(['#1', '#2', '#3', '#4'])
  })
})

describe('countTasks', () => {
  test('counts checkboxes under ## Tasks until the next ## heading', () => {
    const body = ['# Story', '- [x] outside before', '## Tasks & Acceptance', '- [x] one', '* [ ] two', '  - [X] nested', '### Sub heading', '- [ ] still tasks', '## Notes', '- [ ] not a task', ''].join('\n')
    expect(countTasks(body)).toEqual({ tasksDone: 2, tasksTotal: 4, reviewOpen: 0, reviewDone: 0 })
  })

  test('[Review] boxes are counted apart, inside or outside the section', () => {
    const body = ['## Tasks', '- [x] a', '- [ ] [Review][Patch] fix', '- [x] [Review][Defer] later', '## Review Findings', '- [ ] [Review][Patch] other', '- [ ] plain outside'].join('\n')
    expect(countTasks(body)).toEqual({ tasksDone: 1, tasksTotal: 1, reviewOpen: 2, reviewDone: 1 })
  })

  test('no Tasks heading, no tasks; a later Tasks heading starts counting', () => {
    expect(countTasks('- [x] loose\n')).toEqual({ tasksDone: 0, tasksTotal: 0, reviewOpen: 0, reviewDone: 0 })
    expect(countTasks('## Intro\n- [x] no\n## Tasks\n- [x] yes\n- [ ] yes\n').tasksTotal).toBe(2)
  })
})

describe('artifact kinds', () => {
  test('planning kinds from the file name', () => {
    const cases: Record<string, string> = {
      'sprint-change-proposal-2026-10-18.md': 'change-proposal',
      'implementation-readiness-report.md': 'readiness',
      'prfaq-demo.md': 'prfaq',
      'game-brief.md': 'game-brief',
      'gdd.md': 'gdd',
      'game-design-document.md': 'gdd',
      'product-brief-demo.md': 'brief',
      'prd.md': 'prd',
      'ux-design-specification.md': 'ux',
      'architecture.md': 'architecture',
      'research-market.md': 'research',
      'epics.md': 'epics',
      'epic-1.md': 'epics',
      'project-context.md': 'project-context',
      'narrative.md': 'narrative',
      'notes.md': 'doc',
    }
    for (const [rel, kind] of Object.entries(cases)) expect([rel, planningKind(rel)]).toEqual([rel, kind])
  })

  test('game-brief is reachable and wins over brief', () => {
    expect(planningKind('game-brief-space.md')).toBe('game-brief')
    expect(planningKind('briefs/game-brief.md')).toBe('game-brief')
    expect(planningKind('product-brief.md')).toBe('brief')
  })

  test('substrings of other words do not count', () => {
    for (const rel of ['linux-notes.md', 'redux-store.md', 'pricing.md', 'decision-log.md', 'specific-case.md', 'preprdx.md', 'epicenter.md', 'prdx.md']) expect([rel, planningKind(rel)]).toEqual([rel, 'doc'])
    for (const rel of ['linux-notes.md', 'redux-store.md', 'pricing.md', 'decision-log.md', 'specific-case.md', 'epicenter.md', 'gateway.md', 'tracer.md', 'configuration.md']) expect([rel, qualityKind(rel)]).toEqual([rel, 'test-doc'])
  })

  test('the file name beats its folders, folders only when the name says nothing', () => {
    expect(planningKind('prds/prd-demo/architecture-notes.md')).toBe('architecture')
    expect(planningKind('prds/prd-demo/prd.md')).toBe('prd')
    expect(planningKind('prds/prd-demo/notes.md')).toBe('prd')
    expect(planningKind('research/ux-findings.md')).toBe('ux')
    expect(planningKind('epics/epic-2-title.md')).toBe('epics')
    expect(planningKind('misc/notes.md')).toBe('doc')
    // the deepest folder that says something wins
    expect(planningKind('architecture/prds/notes.md')).toBe('prd')
  })

  test('plural forms match', () => {
    expect(planningKind('epics.md')).toBe('epics')
    expect(planningKind('prds/notes.md')).toBe('prd')
    expect(planningKind('briefs.md')).toBe('brief')
    expect(qualityKind('reviews/notes.md')).toBe('test-review')
    expect(qualityKind('gates/notes.md')).toBe('gate')
  })

  test('quality kinds the summary relies on', () => {
    const cases: Record<string, string> = {
      'atdd-checklist-1-1.md': 'atdd',
      'automation-summary.md': 'automation',
      'traceability-matrix.md': 'trace',
      'traceability/epic-1.md': 'trace',
      'e2e-trace-summary.md': 'trace',
      'trace-coverage-matrix.md': 'trace',
      'nfr-assessment.md': 'nfr',
      'gate-decision-1-1.md': 'gate',
      'test-design-epic-1.md': 'test-design',
      'test-design/epic-1.md': 'test-design',
      'test-review.md': 'test-review',
      'test-review-1-1.md': 'test-review',
      'framework-setup.md': 'framework',
      'ci-pipeline-progress.md': 'ci',
      'ci.yaml': 'ci',
      'misc.md': 'test-doc',
    }
    for (const [rel, kind] of Object.entries(cases)) expect([rel, qualityKind(rel)]).toEqual([rel, kind])
  })

  test('tokens split on slash, dash, underscore, dot and space', () => {
    expect(planningKind('game_brief.md')).toBe('game-brief')
    expect(planningKind('game brief.md')).toBe('game-brief')
    expect(planningKind('v1.prd.md')).toBe('prd')
    expect(qualityKind('ci_setup.md')).toBe('ci')
  })
})

describe('skillOf', () => {
  test('required is the whole word true or yes', () => {
    const req = (v: string | undefined) => skillOf({ skill: 's', required: v as string }).required
    for (const v of ['true', 'True', 'YES', 'yes']) expect(req(v)).toBe(true)
    for (const v of ['false', 'no', 'untrue', 'eyes', 'true story', 'yes please', '', undefined]) expect(req(v)).toBe(false)
  })
})

describe('small parsers', () => {
  test('storyNumbers', () => {
    expect(storyNumbers('1-2-second')).toEqual({ epic: 1, num: '2' })
    expect(storyNumbers('1-2a-second')).toEqual({ epic: 1, num: '2a' })
    expect(storyNumbers('spec-3-4-name')).toEqual({ epic: 3, num: '4' })
    expect(storyNumbers('dw-2-5-x')).toEqual({ epic: 2, num: '5' })
    expect(storyNumbers('5-6')).toEqual({ epic: 5, num: '6' })
    expect(storyNumbers('epic-1')).toBeUndefined()
    expect(storyNumbers('walking-skeleton')).toBeUndefined()
  })

  test('parseEpicTitles skips fenced code and keeps the first title', () => {
    const { epics, stories } = parseEpicTitles('# Epics\n## Epic 1: Foundation ##\n### Story 1.1: Skeleton\n### Story 1.2a: Second\n```\n## Epic 9: Fenced\n```\n## Epic 1: Again\n## Epic 2\n')
    expect([...epics]).toEqual([[1, 'Foundation']])
    expect([...stories]).toEqual([
      ['1-1', 'Skeleton'],
      ['1-2a', 'Second'],
    ])
  })

  test('parseSprintDate reads MM-DD-YYYY and ISO dates', () => {
    expect(parseSprintDate('10-16-2026 09:11')).toBe(new Date(2026, 9, 16, 9, 11).getTime())
    expect(parseSprintDate('10-16-2026')).toBe(new Date(2026, 9, 16).getTime())
    expect(parseSprintDate('2026-10-18T15:00:00Z')).toBe(new Date(2026, 9, 18, 15, 0).getTime())
    expect(parseSprintDate('2026-10-18')).toBe(new Date(2026, 9, 18).getTime())
    expect(parseSprintDate('yesterday')).toBeUndefined()
    expect(parseSprintDate(undefined)).toBeUndefined()
  })

  test('the backlog epic number', () => {
    expect(BACKLOG_EPIC).toBe(999)
  })
})

// ---------- snapshot level ----------

const RUN = `${ROOT}/.bmad-loop/runs/20261018-224447-4380`
const state = (extra: Record<string, unknown>) => JSON.stringify({ run_type: 'story', started_at: '2026-10-18T22:44:48', tasks: {}, ...extra })

async function runStatus($: any, on: any, files: Record<string, string>, ps?: (pid: string) => string | undefined) {
  fakeProject(on, { ...FILES, ...files }, ROOT, ps)
  const loop = await status($, 'loop')
  return loop.runs[0]
}

describe('bmad-loop run status', () => {
  test('running: a live pid whose command line is the engine', async ($, on) => {
    const seen: string[] = []
    const run = await runStatus($, on, {}, pid => (seen.push(pid), 'python -m bmad_loop.cli run\n'))
    expect(seen).toContain('4242')
    expect(run).toMatchObject({ status: 'running', pid: 4242, currentStory: '1-2-second', currentPhase: 'dev-running' })
  })

  test('running: the command line may spell it bmad-loop', async ($, on) => {
    expect((await runStatus($, on, {}, () => '/usr/bin/python3 /opt/bmad-loop/bin/engine run\n')).status).toBe('running')
  })

  test('stopping: a stop-request next to a live pid', async ($, on) => {
    const run = await runStatus($, on, { [`${RUN}/stop-request.json`]: JSON.stringify({ mode: 'immediate' }) })
    expect(run).toMatchObject({ status: 'stopping', stopRequested: 'immediate' })
  })

  test('stopping: an unreadable stop-request means graceful', async ($, on) => {
    const run = await runStatus($, on, { [`${RUN}/stop-request.json`]: 'not json' })
    expect(run).toMatchObject({ status: 'stopping', stopRequested: 'graceful' })
  })

  test('interrupted: a pid file, but ps prints nothing', async ($, on) => {
    const run = await runStatus($, on, {}, () => undefined)
    expect(run.status).toBe('interrupted')
  })

  test('interrupted: the pid was recycled by an unrelated program', async ($, on) => {
    const run = await runStatus($, on, {}, () => '/Applications/Safari.app/Contents/MacOS/Safari\n')
    expect(run.status).toBe('interrupted')
  })

  test('interrupted: a dead run with a stop-request is not stopping', async ($, on) => {
    const run = await runStatus($, on, { [`${RUN}/stop-request.json`]: '{}' }, () => 'vim notes.md\n')
    expect(run.status).toBe('interrupted')
  })

  test('finished: the state says so, whatever the pid is', async ($, on) => {
    expect((await runStatus($, on, { [`${RUN}/state.json`]: state({ finished: true }) }, () => undefined)).status).toBe('finished')
  })

  test('paused: paused_reason in the state', async ($, on) => {
    const run = await runStatus($, on, { [`${RUN}/state.json`]: state({ paused_reason: 'gate', paused_stage: 'review', paused_story_key: '1-2-second' }) })
    expect(run).toMatchObject({ status: 'paused', pausedReason: 'gate', pausedStage: 'review', pausedStory: '1-2-second', currentStory: '1-2-second' })
  })

  test('crashed: the state says so', async ($, on) => {
    const run = await runStatus($, on, { [`${RUN}/state.json`]: state({ crashed: true, crash_error: 'boom' }) }, () => undefined)
    expect(run).toMatchObject({ status: 'crashed', crashError: 'boom' })
  })

  test('unknown: no pid file and nothing in the state', async ($, on) => {
    const { [`${RUN}/engine.pid`]: _pid, ...files } = FILES
    fakeProject(on, files)
    expect((await status($, 'loop')).runs[0].status).toBe('unknown')
  })
})

describe('snapshot', () => {
  test('a session whose status is incomplete is still in progress; a complete one is hidden', async ($, on) => {
    const memlog = (status: string) => `---\nstatus: ${status}\ntopic: ${status} session\n---\n- step one\n`
    fakeProject(on, {
      ...FILES,
      [`${ROOT}/_bmad-output/brainstorming/a/.memlog.md`]: memlog('incomplete'),
      [`${ROOT}/_bmad-output/brainstorming/b/.memlog.md`]: memlog('complete'),
      [`${ROOT}/_bmad-output/brainstorming/c/.memlog.md`]: memlog('in-progress'),
      [`${ROOT}/_bmad-output/brainstorming/d/.memlog.md`]: memlog('final'),
    })
    const s = await status($, 'planning')
    expect(s.inProgressSessions.map((a: any) => a.title).sort()).toEqual(['in-progress session', 'incomplete session'])
  })

  test('deferred work reads unresolved as open', async ($, on) => {
    fakeProject(on, {
      ...FILES,
      [`${ROOT}/_bmad-output/implementation-artifacts/deferred-work.md`]: '### DW-1: a\n- status: unresolved\n\n### DW-2: b\n- status: resolved\n',
    })
    const s = await status($, 'debt')
    expect(s.deferred.map((d: any) => [d.id, d.status])).toEqual([
      ['DW-1', 'unresolved'],
      ['DW-2', 'done'],
    ])
  })

  test('planning artifacts get their kind from the file name', async ($, on) => {
    fakeProject(on, {
      ...FILES,
      [`${ROOT}/_bmad-output/planning-artifacts/prds/prd-demo/architecture-notes.md`]: '# Notes\n',
      [`${ROOT}/_bmad-output/planning-artifacts/game-brief.md`]: '# Game\n',
    })
    const s = await status($, 'planning')
    const kinds = Object.fromEntries(s.planning.map((a: any) => [a.path, a.kind]))
    expect(kinds['prds/prd-demo/architecture-notes.md']).toBe('architecture')
    expect(kinds['prds/prd-demo/prd.md']).toBe('prd')
    expect(kinds['game-brief.md']).toBe('game-brief')
  })

  test('the builder skill with an incomplete memlog is in progress', async ($, on) => {
    const dir = `${ROOT}/skills`
    const skill = (name: string, status: string) => ({
      [`${dir}/${name}/SKILL.md`]: '# skill\n',
      [`${dir}/${name}/.memlog.md`]: `---\nstatus: ${status}\n---\n`,
    })
    fakeProject(on, {
      ...FILES,
      [`${ROOT}/_bmad/config.toml`]: `${FILES[`${ROOT}/_bmad/config.toml`]}\n[modules.bmb]\nbmad_builder_output_folder = "{project-root}/skills"\n`,
      ...skill('a', 'incomplete'),
      ...skill('b', 'complete'),
      ...skill('c', 'done'),
    })
    const s = await status($, 'modules')
    expect(Object.fromEntries(s.builder.map((b: any) => [b.name, b.inProgress]))).toEqual({ a: true, b: false, c: false })
  })
})

// ---------- refresh cost and scripts ----------

const TICKETS_PY = `${V7}/_bmad/method/scripts/tickets.py`
const TOML = `${V7}/_bmad-output/initiative-demo/tickets/tickets.toml`
const ranTickets = (calls: string[][]) => calls.filter(a => a.includes(TICKETS_PY))

describe('scripts and the session project', () => {
  test('the session project runs its tickets.py and has no note', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, V7_TICKET_FILES, V7, undefined, { calls })
    const s = await status($, 'all')
    expect(ranTickets(calls)).toHaveLength(1)
    expect(s.sprint.counts).toEqual({ done: 1, review: 1, backlog: 1, 'in-progress': 1 })
    expect(s.sprintNote).toBeUndefined()
    expect(s.errors).toEqual([])
  })

  test('another project picked on the Projects tab never runs its tickets.py', async ($, on) => {
    const calls: string[][] = []
    const find = (argv: readonly string[]) => (argv[0] === 'find' ? { exitCode: 0, stdout: `${V7}/_bmad\n`, stderr: '' } : undefined)
    fakeProject(on, { ...FILES, ...V7_TICKET_FILES }, ROOT, undefined, { calls, run: find })
    await $.command.run({ command: 'bmad-dashboard', args: 'scan' } as never)
    await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'bmad-dashboard', surface: 'terminal', component: 'Pane', requestId: 'bmad', props: { title: 'BMAD', isFocused: true, bodyColumns: 90, placement: 'dock' } as never })
    await ui.press({ key: 'tab-projects' })
    await ui.press({ key: `p-${V7}` })
    const s = await status($, 'all')
    await ui.unmount()
    expect(s.root).toBe(V7)
    expect(ranTickets(calls)).toEqual([])
    expect(calls.some(a => a[0] === 'python3' || a[0] === 'uv')).toBe(false)
    expect(s.sprint).toBeUndefined()
    expect(s.sprintNote).toBe("The ticket tree is only read for the session's project, because reading it runs the project's tickets.py.")
    expect(s.errors).toEqual([]) // a note, not a red alert
  })
})

describe('tickets.py cache', () => {
  test('two reads run the script once; a change in the initiative folder runs it again', async ($, on) => {
    const calls: string[][] = []
    const files = { ...V7_TICKET_FILES }
    fakeProject(on, files, V7, undefined, { calls })
    const first = await status($, 'sprint')
    const second = await status($, 'sprint')
    expect(ranTickets(calls)).toHaveLength(1)
    expect(second.sprint.epics).toEqual(first.sprint.epics)
    files[TOML] += '# touched\n'
    await status($, 'sprint')
    expect(ranTickets(calls)).toHaveLength(2)
  })

  test('a change to the script itself runs it again', async ($, on) => {
    const calls: string[][] = []
    const files = { ...V7_TICKET_FILES }
    fakeProject(on, files, V7, undefined, { calls })
    await status($, 'sprint')
    files[TICKETS_PY] = JSON.stringify({ epics: [], tickets: [] })
    const s = await status($, 'sprint')
    expect(ranTickets(calls)).toHaveLength(2)
    expect(s.sprint.counts).toEqual({})
  })

  test('the launcher that worked goes first the next time', async ($, on) => {
    const calls: string[][] = []
    const files = { ...V7_TICKET_FILES }
    fakeProject(on, files, V7, undefined, { calls, run: argv => (argv[0] === 'python3' ? { exitCode: 1, stdout: '', stderr: 'python 3.9 is too old' } : undefined) })
    await status($, 'sprint')
    expect(ranTickets(calls).map(a => a[0])).toEqual(['python3', 'uv'])
    calls.length = 0
    files[TOML] += '# touched\n'
    const s = await status($, 'all')
    expect(ranTickets(calls).map(a => a[0])).toEqual(['uv'])
    expect(s.sprint.counts.done).toBe(1)
    expect(s.errors).toEqual([])
  })

  test('a failing script is reported and run again on the next read', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, V7_TICKET_FILES, V7, undefined, { calls, run: argv => (argv.includes(TICKETS_PY) ? { exitCode: 1, stdout: '', stderr: 'boom' } : undefined) })
    expect((await status($, 'all')).errors).toEqual(['tickets.py failed: boom'])
    await status($, 'all')
    expect(ranTickets(calls)).toHaveLength(4) // both launchers, twice
  })
})

describe('bmad-loop run cache', () => {
  const count = (calls: string[][], bin: string) => calls.filter(a => a[0] === bin).length

  test('a finished run is not read again while its files hold', async ($, on) => {
    const calls: string[][] = []
    const files = { ...FILES, [`${RUN}/state.json`]: state({ finished: true }) }
    fakeProject(on, files, ROOT, undefined, { calls })
    const first = (await status($, 'loop')).runs[0]
    expect(count(calls, 'tail')).toBe(1)
    const second = (await status($, 'loop')).runs[0]
    expect(count(calls, 'tail')).toBe(1)
    expect(count(calls, 'ps')).toBe(0)
    expect(second).toEqual(first)
    expect(second.status).toBe('finished')
    // the journal changed: the run is built again
    files[`${RUN}/journal.jsonl`] = JSON.stringify({ ts: 1, kind: 'session-end', task_id: 't' }) + '\n'
    await status($, 'loop')
    expect(count(calls, 'tail')).toBe(2)
  })

  for (const [name, st] of [
    ['crashed', { crashed: true, crash_error: 'x' }],
    ['stopped', { stopped: true }],
  ] as const) {
    test(`a ${name} run is cached too`, async ($, on) => {
      const calls: string[][] = []
      fakeProject(on, { ...FILES, [`${RUN}/state.json`]: state(st) }, ROOT, undefined, { calls })
      expect((await status($, 'loop')).runs[0].status).toBe(name)
      await status($, 'loop')
      expect(count(calls, 'tail')).toBe(1)
    })
  }

  test('a running run is read every time', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, FILES, ROOT, undefined, { calls })
    await status($, 'loop')
    await status($, 'loop')
    expect(count(calls, 'ps')).toBe(2)
    expect(count(calls, 'tail')).toBe(2)
  })

  test('a paused run is read every time', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, { ...FILES, [`${RUN}/state.json`]: state({ paused_reason: 'gate' }) }, ROOT, undefined, { calls })
    await status($, 'loop')
    await status($, 'loop')
    expect(count(calls, 'tail')).toBe(2)
  })

  test('runs come back newest first, as before', async ($, on) => {
    const other = `${ROOT}/.bmad-loop/runs/20261017-101010-aaaa`
    fakeProject(on, { ...FILES, [`${other}/state.json`]: state({ finished: true }), [`${ROOT}/.bmad-loop/runs/20261019-101010-bbbb/state.json`]: state({ finished: true }) })
    const loop = await status($, 'loop')
    expect(loop.runs.map((r: any) => r.runId)).toEqual(['20261019-101010-bbbb', '20261018-224447-4380', '20261017-101010-aaaa'])
    expect(loop.runs.map((r: any) => r.status)).toEqual(['finished', 'running', 'finished'])
  })
})

describe('collect in parallel', () => {
  test('the snapshot keeps its arrays in order', async ($, on) => {
    fakeProject(on, {
      ...FILES,
      [`${ROOT}/_bmad-output/specs/x/SPEC.md`]: '# Spec\n',
      [`${ROOT}/_bmad-output/project-context.md`]: '# Context\n',
    })
    const s = await status($, 'all')
    // planning docs first, then specs, then project-context
    expect(s.planning.map((a: any) => a.kind).slice(-2)).toEqual(['spec', 'project-context'])
    expect(s.planning.slice(-2).map((a: any) => a.path)).toEqual(['specs/x/SPEC.md', 'project-context.md'])
    expect(s.planning.map((a: any) => a.path).sort()).toEqual(['epics.md', 'prds/prd-demo/prd.md', 'project-context.md', 'specs/x/SPEC.md'])
    expect(s.sprint.epics.map((e: any) => e.num)).toEqual([1])
    expect(s.sprint.epics[0].stories.map((x: any) => x.key)).toEqual(['1-1-skeleton', '1-2-second'])
    expect(s.loop.runs.map((r: any) => r.ref)).toEqual(['4380'])
    expect(s.deferred.map((d: any) => d.id)).toEqual(['DW-1'])
    expect(s.qualitySummary.gates.map((g: any) => g.target)).toEqual(['1-1-skeleton'])
    expect(s.errors).toEqual([])
  })

  test('epic titles come from epics files only, not from words that contain "epic"', async ($, on) => {
    fakeProject(on, { [`${ROOT}/_bmad-output/planning-artifacts/a-epicenter.md`]: '## Epic 1: Wrong\n', ...FILES })
    const s = await status($, 'sprint')
    expect(s.sprint.epics[0].title).toBe('Foundation')
  })
})

import { describe, expect, test } from 'claude-code/testing'

import { frontmatter, parseCsv, parseToml, parseYaml } from '../hooks/parse'
import { reviewScore } from '../hooks/modules'
import { TICKETS_NOTE } from '../hooks/collect'
import { FILES, ROOT, SPRINT, SURFACES, V7, V7_FILES, V7_TICKET_FILES, fakeProject, found, mountPane, status, until } from './fixture'

describe('parsers', () => {
  test('sprint-status yaml', async () => {
    const y = parseYaml(SPRINT) as Record<string, any>
    expect(y.project).toBe('fulcro')
    expect(y.development_status['1-2a-second-story']).toBe('in-progress')
    expect(y.development_status['epic-1-retrospective']).toBe('optional')
    expect(y.action_items).toHaveLength(2)
    expect(y.action_items[0].action).toBe('Land session lifecycle fixes: re-key')
    expect(y.action_items[1].epic).toBe(2)
  })

  test('frontmatter with flow lists and nested lists', async () => {
    const doc = frontmatter(`---
title: 'Spec: thing'
status: in-review
stepsCompleted: ['step-01', 'step-02']
inputDocuments:
  - a.md
  - b.md
---

# Heading
`)
    expect(doc.fm.title).toBe('Spec: thing')
    expect(doc.fm.status).toBe('in-review')
    expect(doc.fm.stepsCompleted).toEqual(['step-01', 'step-02'])
    expect(doc.fm.inputDocuments).toEqual(['a.md', 'b.md'])
    expect(doc.body.trim()).toBe('# Heading')
  })

  test('toml layers', async () => {
    const t = parseToml(`[core]
project_name = "fulcro" # comment
output_folder = "{project-root}/_bmad-output"

[modules.bmm]
planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"

[agents.bmad-agent-dev]
name = "Amelia"
icon = "💻"

[plugins]
enabled = [
  "tea",
]
`) as Record<string, any>
    expect(t.core.project_name).toBe('fulcro')
    expect(t.modules.bmm.planning_artifacts).toBe('{project-root}/_bmad-output/planning-artifacts')
    expect(t.agents['bmad-agent-dev'].name).toBe('Amelia')
    expect(t.plugins.enabled).toEqual(['tea'])
  })

  test('csv with quoted commas', async () => {
    const rows = parseCsv('module,skill,description\nbmm,bmad-build,"Build, then review"\n')
    expect(rows[0]?.description).toBe('Build, then review')
  })

  test('TEA review score in both spellings', async () => {
    expect(reviewScore('**Quality score: 88/100 (B, approve with comments)**')).toEqual({ qualityScore: '88', grade: 'B', recommendation: 'approve with comments' })
    expect(reviewScore('**Quality Score**: 72/100 (C)\n\n**Recommendation**: Request Changes').recommendation).toBe('Request Changes')
  })
})

describe('pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws on ${surface} before the first snapshot`, async $ => {
      const ui = await $.ui.mount({
        plugin: 'bmad-dashboard',
        surface,
        component: 'Pane',
        requestId: 'bmad',
        props: { title: 'BMAD', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
      })
      expect(await ui.find({ type: 'Text' })).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('pane over a project', () => {
  for (const surface of SURFACES) {
    test(`every tab shows its content on ${surface}`, async ($, on) => {
      fakeProject(on)
      await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
      const ui = await mountPane($, surface)
      const seen = async (re: RegExp) => {
        if (!(await ui.find({ type: 'Text', text: re }))) throw new Error(`no Text matching ${re}`)
      }
      const open = (id: string) => ui.press({ key: `tab-${id}` })

      // overview: the project name and an alert
      await seen(/^demo/)
      await seen(/1 TEA quality gate\(s\) FAIL/)
      await seen(/open deferred work item/)

      await open('sprint')
      await seen(/E1/) // an epic row
      await seen(/Second/) // a story
      await seen(/1\.2/)

      await open('loop')
      await seen(/4380/)
      await seen(/dev-running/)

      await open('planning')
      await seen(/Demo PRD/)

      await open('quality')
      await seen(/FAIL/)

      await open('debt')
      await seen(/pending thing/)
      await seen(/Deferred work \(1 open \/ 1\)/)
      await seen(/Retro action items \(1 open \/ 2\)/)

      await open('modules')
      await seen(/^bmad-loop$/)
      await seen(/Modules \(2\)/)

      await open('projects')
      await seen(/^demo$/)
      await seen(/Projects \(1\)/)

      await open('overview')
      await seen(/^demo/)
      await ui.unmount()
    })
  }
})

describe('sprint of a v7 project', () => {
  const loose = (file: string, state: string) => ({ epic: 'backlog', id: null, file, type: 'story', title: file, state, risk: '', blocked_reason: '', ref: file })
  const withBacklog = {
    ...V7_TICKET_FILES,
    [`${V7}/_bmad/method/scripts/tickets.py`]: JSON.stringify({
      epics: [{ slug: 'epic-a', id: 1, status: '' }],
      tickets: [
        { epic: 'epic-a', id: 1, type: 'story', title: 'First', state: 'done', risk: '', blocked_reason: '', ref: '1.1' },
        { epic: 'epic-a', id: 2, type: 'story', title: 'Second', state: 'planned', risk: '', blocked_reason: '', ref: '1.2' },
      ],
      backlog: { tickets: [loose('story-a.md', 'done'), loose('story-b.md', 'planned')] },
    }),
  }

  test('the backlog epic reads backlog, never 999, and p/n reach it', async ($, on) => {
    fakeProject(on, withBacklog, V7)
    await $.command.run({ command: 'bmad-dashboard', args: 'sprint' } as never)
    const ui = await mountPane($, 'terminal')
    const text = async (re: RegExp) => ui.find({ type: 'Text', text: re })

    expect(await text(/^backlog/)).toBeDefined() // its row in the epic list
    expect(await text(/999/)).toBeUndefined()
    expect(await text(/Epic 1: Epic A title/)).toBeDefined() // the current epic is the first with an open story

    await ui.press({ key: 'next-epic' })
    expect(await text(/^Backlog$/)).toBeDefined() // the section title
    expect(await text(/story-b\.md/)).toBeDefined()
    expect(await text(/999/)).toBeUndefined()
    expect(await text(/Epic 999/)).toBeUndefined()

    await ui.press({ key: 'prev-epic' })
    expect(await text(/Epic 1: Epic A title/)).toBeDefined()

    await ui.press({ key: 'tab-overview' })
    expect(await text(/999/)).toBeUndefined()
    await ui.unmount()
  })

  test('a project whose tickets were not read shows the note instead of "No tickets"', async ($, on) => {
    // the session runs in demo, so the v7 project may not run its script
    fakeProject(on, { ...FILES, ...V7_TICKET_FILES }, ROOT, undefined, { run: argv => (argv[0] === 'find' ? found(V7) : undefined) })
    await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    await $.command.run({ command: 'bmad-dashboard', args: 'scan' } as never)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-projects' })
    await ui.press({ key: `p-${V7}` })
    // switching lands on the overview
    expect(await ui.find({ type: 'Text', text: /^v7demo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: TICKETS_NOTE })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No tickets for the active initiative/ })).toBeUndefined()
    await ui.press({ key: 'tab-sprint' })
    expect(await ui.find({ type: 'Text', text: TICKETS_NOTE })).toBeDefined()
    await ui.unmount()
  })
})

describe('lists that are cut', () => {
  test('say how many rows are left out', async ($, on) => {
    const dw = Array.from({ length: 25 }, (_, i) => `### DW-${i + 1}: item ${i + 1}\n- severity: low\n- status: open\n`).join('\n')
    fakeProject(on, { ...FILES, [`${ROOT}/_bmad-output/implementation-artifacts/deferred-work.md`]: dw })
    await $.command.run({ command: 'bmad-dashboard', args: 'debt' } as never)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Deferred work \(25 open \/ 25\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /item 20$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /item 21$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '+5 more' })).toBeDefined()
    await ui.unmount()
  })

  test('a list that fits has no such line', async ($, on) => {
    fakeProject(on)
    await $.command.run({ command: 'bmad-dashboard', args: 'debt' } as never)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /\+\d+ more/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('switching project', () => {
  const OTHER = '/work/other'
  const files = { ...FILES, [`${OTHER}/_bmad/config.toml`]: '[core]\nproject_name = "other"\n' }

  test('during a refresh ends on the new project', async ($, on) => {
    let gate: Promise<void> | undefined
    let release!: () => void
    let held = 0
    const calls: string[][] = []
    fakeProject(on, files, ROOT, undefined, {
      calls,
      run: async argv => {
        if (argv[0] === 'find') return found(OTHER)
        if (gate && argv[0] === 'git' && argv[2] === ROOT) {
          held++
          await gate
        }
        return undefined
      },
    })
    await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    await $.command.run({ command: 'bmad-dashboard', args: 'scan' } as never)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-projects' })

    // a refresh of the session project is under way (its git call is held) ...
    gate = new Promise<void>(r => (release = r))
    const inflight = status($, 'alerts')
    await until(() => held > 0, 'the refresh to start')
    // ... when the user picks the other project
    const press = ui.press({ key: `p-${OTHER}` })
    await new Promise(r => setTimeout(r, 30))
    release()
    await Promise.all([inflight, press])

    // no new tool call here: that would refresh again and hide a dropped request
    expect(await ui.find({ type: 'Text', text: /^other/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^demo/ })).toBeUndefined()
    // the demo project was read once before and once while held; the new one once
    expect(calls.filter(a => a[0] === 'git' && a[2] === OTHER && a[3] === 'status')).toHaveLength(1)
    await ui.unmount()
  })
})

describe('scan', () => {
  const ROOTS = ['/work/demo', '/work/other', '/work/third']

  test('the button shows that it runs, then what it found', async ($, on) => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const calls: string[][] = []
    fakeProject(on, FILES, ROOT, undefined, {
      calls,
      // a saved project whose _bmad folder is gone
      store: { projects: [{ root: '/work/gone', name: 'gone', lastSeen: 1 }] },
      run: async argv => {
        if (argv[0] !== 'find') return undefined
        await gate
        return found(...ROOTS)
      },
    })
    await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-projects' })
    expect(await ui.find({ type: 'Text', text: /Searching in: \/work$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Scan:/ })).toBeUndefined()

    const press = ui.press({ key: 'scan' })
    await until(async () => (await ui.find({ type: 'Text', text: 'Scanning…' })) !== undefined, 'the scanning line')
    release()
    await press
    expect(await ui.find({ type: 'Text', text: 'Scanning…' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Scan: 3 found, 2 new, 1 removed' })).toBeDefined()

    expect(await ui.find({ type: 'Text', text: /Projects \(3\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^gone$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^third$/ })).toBeDefined()

    // node_modules and dot folders are pruned, not walked
    const argv = calls.find(a => a[0] === 'find')!
    expect(argv[1]).toBe('/work')
    expect(argv).toContain('-prune')
    expect(argv.join(' ')).not.toContain('-not')
    await ui.unmount()
  })

  test('the command and the button search the same folders, without empty entries', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, FILES, ROOT, undefined, { calls, run: argv => (argv[0] === 'find' ? found() : undefined) })
    await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    const r = await $.command.run({ command: 'bmad-dashboard', args: 'scan' } as never)
    expect((r as { text: string }).text).toContain('0 found, 0 new')
    expect(calls.filter(a => a[0] === 'find').map(a => a[1])).toEqual(['/work'])

    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-projects' })
    await ui.press({ key: 'scan' })
    expect(calls.filter(a => a[0] === 'find').map(a => a[1])).toEqual(['/work', '/work'])
    await ui.unmount()
  })

  test('configured folders are used as given, empty entries dropped', { options: { scanRoots: ' , /a/b ,, /c' } }, async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, FILES, ROOT, undefined, { calls, run: argv => (argv[0] === 'find' ? found() : undefined) })
    await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    await $.command.run({ command: 'bmad-dashboard', args: 'scan' } as never)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-projects' })
    expect(await ui.find({ type: 'Text', text: 'Searching in: /a/b, /c' })).toBeDefined()
    await ui.press({ key: 'scan' })
    expect(calls.filter(a => a[0] === 'find').map(a => a[1])).toEqual(['/a/b', '/c', '/a/b', '/c'])
    await ui.unmount()
  })
})

describe('layout', () => {
  test('v6 reads the manifest and bmad-help.csv', async ($, on) => {
    fakeProject(on)
    const s = await status($, 'all')
    expect(s.project.layout).toBe('v6')
    expect(s.project.bmadVersion).toBe('6.12.4')
    expect(s.project.ides).toEqual(['claude-code'])
    expect(s.modules.map((m: any) => `${m.name}@${m.version}`)).toEqual(['core@6.12.4', 'bmad-loop@v0.13.2'])
    expect(s.skills).toEqual([{ name: 'Create PRD', module: 'bmm', description: 'Write the PRD.', phase: '2-planning', menuCode: 'CP', required: true }])
    expect(s.agents.map((a: any) => a.name)).toEqual(['Amelia'])
  })

  test('v7 reads bmod.toml, module-help.csv and config.toml agents', async ($, on) => {
    fakeProject(on, V7_FILES, V7)
    const s = await status($, 'all')
    expect(s.project.layout).toBe('v7')
    expect(s.project.bmadVersion).toBe('6.13.0-next') // the method module's, not the first one listed
    expect(s.project.ides).toEqual([])
    expect(s.modules).toEqual([
      { name: 'bmad-loop', version: '6.12.4' },
      { name: 'core-tools', version: '6.12.4', source: 'github:acme/core' },
      { name: 'method', version: '6.13.0-next', source: 'github:acme/method' },
      { name: 'tea', version: '6.12.4' },
    ])
    expect(s.skills).toEqual([
      { name: 'Test Design', module: 'TEA', description: 'Risk-based test planning.', phase: '3-solutioning', menuCode: 'TD', required: false },
      // no module-help.csv for these: the skills list of bmod.toml; the one the csv covers is not repeated
      { name: 'bmad', module: 'core-tools', required: true },
      { name: 'bmad-prd', module: 'method', required: false },
    ])
    expect(s.agents).toEqual([{ code: 'bmad-agent-dev', name: 'Amelia', title: 'Dev', icon: '💻', module: 'bmm' }])
    expect(s.paths.tests).toBe(`${V7}/_bmad-output/qa`)
    expect(s.sprint).toBeUndefined()
  })

  test('v7 fills the sprint from the ticket tree script', async ($, on) => {
    fakeProject(on, V7_TICKET_FILES, V7)
    const s = await status($, 'all')
    expect(s.errors).toEqual([])
    expect(s.sprint.file).toBe('_bmad-output/initiative-demo/tickets/tickets.toml')
    expect(s.sprint.counts).toEqual({ done: 1, review: 1, backlog: 1, 'in-progress': 1 })
    expect(s.sprint.epics.map((e: any) => [e.num, e.title, e.stories.length])).toEqual([
      [1, 'Epic A title', 3],
      [2, 'epic-b', 1], // no title in tickets.toml: the slug
    ])
    const [first, spike, bug] = s.sprint.epics[0].stories
    expect(first).toMatchObject({ key: '1.1', epic: 1, num: '1', title: 'First', status: 'done', risk: 'medium' })
    expect(first.type).toBeUndefined()
    expect(spike).toMatchObject({ num: '2', status: 'review', type: 'spike', risk: 'high' })
    expect(bug).toMatchObject({ status: 'backlog', type: 'bug', blockedReason: 'waits for CVM' })
    expect(s.sprint.epics[1].stories[0]).toMatchObject({ epic: 2, status: 'in-progress' })
    expect(s.sprint.epics[1].stories[0].risk).toBeUndefined() // an empty risk is left out
  })

  test('v7 initiative without epics lists its backlog stories as one epic', async ($, on) => {
    const backlog = (file: string, state: string) => ({ epic: 'backlog', id: null, file, type: 'story', title: file, state, risk: '', blocked_reason: '', ref: file })
    fakeProject(
      on,
      {
        ...V7_TICKET_FILES,
        [`${V7}/_bmad-output/initiative-demo/tickets/tickets.toml`]: `# no [[epic]]: loose stories live in backlog/\n`,
        [`${V7}/_bmad/method/scripts/tickets.py`]: JSON.stringify({ tickets: [], counts: { total: 0 }, backlog: { tickets: [backlog('story-a.md', 'done'), backlog('story-b.md', 'planned')] } }),
      },
      V7,
    )
    const s = await status($, 'all')
    expect(s.errors).toEqual([])
    expect(s.sprint.counts).toEqual({ done: 1, backlog: 1 })
    expect(s.sprint.epics.map((e: any) => [e.num, e.title, e.stories.length])).toEqual([[999, 'backlog', 2]])
    expect(s.sprint.epics[0].stories[0]).toMatchObject({ key: 'story-a.md', epic: 999, num: '', status: 'done' })
  })

  test('v7 without tickets leaves the sprint empty, and says so when the script is gone', async ($, on) => {
    const { [`${V7}/_bmad/method/scripts/tickets.py`]: _stub, ...noScript } = V7_TICKET_FILES
    fakeProject(on, noScript, V7)
    const s = await status($, 'all')
    expect(s.sprint).toBeUndefined()
    expect(s.errors).toEqual(['_bmad/method/scripts/tickets.py not found'])
  })

  test('a v7-only project (no _bmad/_config) is found from a subfolder', async ($, on) => {
    fakeProject(on, V7_FILES, `${V7}/src/deep`)
    expect((await status($, 'all')).root).toBe(V7)
  })
})

describe('status tool', () => {
  test('returns the summary by default, as compact JSON', async ($, on) => {
    fakeProject(on)
    const raw = (await $.tool.call({ tool: 'mcp__bmad-dashboard__status' })).result as string
    expect(raw).not.toContain('\n')
    const s = JSON.parse(raw)
    expect(s.project).toBe('demo')
    expect(s.bmadVersion).toBe('6.12.4')
    expect(s.layout).toBe('v6')
    expect(s.modules).toEqual(['core', 'bmad-loop'])
    expect(s.sprint.counts).toEqual({ done: 1, 'in-progress': 1 })
    expect(s.epics).toEqual([{ num: 1, label: 'E1', title: 'Foundation', status: 'in-progress', done: 1, total: 2, dropped: 0 }])
    expect(s.inProgress).toEqual([{ ref: '1.2', title: 'Second', status: 'in-progress' }])
    expect(s.loop).toMatchObject({ status: 'running', phase: 'dev-running', tokensWeighted: expect.any(Number) })
    expect(s.alerts.map((a: any) => a.text)).toContain('1 TEA quality gate(s) FAIL')
    expect(s.open).toEqual({ deferredWork: 1, actionItems: 1, reviewFindings: 1 })
    // far smaller than the snapshot
    const all = (await $.tool.call({ tool: 'mcp__bmad-dashboard__status', section: 'all' })).result as string
    expect(raw.length).toBeLessThan(all.length / 2)
    expect(all).not.toContain('\n')
  })

  test('an unknown section falls back to the summary; the other sections stay', async ($, on) => {
    fakeProject(on)
    expect((await status($, 'nonsense')).project).toBe('demo')
    expect((await status($, 'all')).root).toBe(ROOT)
    expect((await status($, 'alerts')).some((a: any) => /FAIL/.test(a.text))).toBe(true)
    expect((await status($, 'loop')).runs).toHaveLength(1)
    expect((await status($, 'debt')).deferred[0].id).toBe('DW-1')
    expect((await status($, 'sprint')).sprint.epics[0].stories).toHaveLength(2)
  })

  test('outside a BMAD project it says so', async ($, on) => {
    fakeProject(on, FILES, '/elsewhere')
    const r = await $.tool.call({ tool: 'mcp__bmad-dashboard__status' })
    expect(r.result).toMatch(/No BMAD project/)
  })
})

describe('dropped work', () => {
  // epic 1 done once its dropped ticket is left out; epic 2 dropped but still holding a backlog ticket; epic 3 has the next one
  const ticket = (epic: string, id: number, title: string, state: string) => ({ epic, id, type: 'story', title, state, risk: '', blocked_reason: '', ref: `${epic}.${id}` })
  const v7 = {
    ...V7_TICKET_FILES,
    [`${V7}/_bmad/method/scripts/tickets.py`]: JSON.stringify({
      epics: [
        { slug: 'epic-a', id: 1, status: 'done' },
        { slug: 'epic-b', id: 2, status: 'dropped' },
        { slug: 'epic-c', id: 3, status: 'in-progress' },
      ],
      tickets: [
        ticket('epic-a', 1, 'Shipped one', 'done'),
        ticket('epic-a', 2, 'Given up one', 'dropped'),
        ticket('epic-b', 1, 'Inside dropped epic', 'backlog'),
        ticket('epic-c', 1, 'Really next', 'planned'),
      ],
    }),
  }

  test('v7: dropped ticket and dropped epic are left out of progress, next and in-progress', async ($, on) => {
    fakeProject(on, v7, V7)
    const opened = await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    expect((opened as { text: string }).text).toContain('BMAD v7demo · E3 0/1 · 1/2 stories')

    const s = await status($)
    expect(s.sprint.dropped).toBe(2)
    expect(s.epics.map((e: any) => [e.num, e.status, e.done, e.total, e.dropped])).toEqual([
      [1, 'done', 1, 1, 1],
      [2, 'dropped', 0, 0, 1],
      [3, 'in-progress', 0, 1, 0],
    ])
    expect(s.next).toMatchObject({ ref: '3.1', title: 'Really next' })
    expect(s.inProgress).toEqual([])

    const ui = await mountPane($, 'terminal')
    const text = (re: RegExp) => ui.find({ type: 'Text', text: re })
    // overview: the total counts live work, and Next is the live ticket
    expect(await text(/^Total\s*$/)).toBeDefined()
    expect(await text(/1\/2 50%/)).toBeDefined()
    expect(await text(/Really next/)).toBeDefined()
    expect(await text(/Inside dropped epic/)).toBeUndefined()

    // sprint: the rows say how many were dropped; the dropped ones stay in their epic's list
    await ui.press({ key: 'tab-sprint' })
    expect(await text(/^ 1 dropped$/)).toBeDefined()
    await ui.press({ key: 'epic-1' })
    expect(await text(/Shipped one/)).toBeDefined()
    expect(await text(/Given up one/)).toBeDefined()
    await ui.press({ key: 'epic-2' })
    expect(await text(/Inside dropped epic/)).toBeDefined()
    await ui.unmount()
  })

  const spec = (name: string, status: string, tasks = '') => ({ [`${ROOT}/_bmad-output/implementation-artifacts/spec-${name}.md`]: `---\ntitle: ${name}\nstatus: ${status}\n---\n## Tasks & Acceptance\n${tasks}` })
  const v6 = {
    ...FILES,
    // the yaml still says backlog; the spec file says dropped
    [`${ROOT}/_bmad-output/implementation-artifacts/sprint-status.yaml`]: 'project: demo\ndevelopment_status:\n  epic-1: backlog\n  1-1-skeleton: done\n  1-2-second: backlog\n  1-3-third: backlog\n',
    ...spec('1-2-second', 'dropped', '- [ ] [Review][Patch] fix it\n'),
    ...spec('9-1-gone', 'dropped'),
    ...spec('9-2-live', 'in-progress'),
  }

  test('v6: a story file marked dropped wins over the yaml', async ($, on) => {
    fakeProject(on, v6)
    const opened = await $.command.run({ command: 'bmad-dashboard', args: '' } as never)
    expect((opened as { text: string }).text).toContain('BMAD demo · E1 1/2 · 1/2 stories')

    const s = await status($)
    expect(s.sprint.counts).toEqual({ done: 1, dropped: 1, backlog: 1 })
    expect(s.sprint.dropped).toBe(1)
    expect(s.epics).toEqual([{ num: 1, label: 'E1', title: 'Foundation', status: 'in-progress', done: 1, total: 2, dropped: 1 }])
    expect(s.next).toMatchObject({ ref: '1.3' })
    expect(s.inProgress).toEqual([])
    expect(s.open.reviewFindings).toBe(0)
    expect(s.alerts.map((a: any) => a.text).join('|')).not.toContain('code review')

    const ui = await mountPane($, 'terminal')
    const text = (re: RegExp) => ui.find({ type: 'Text', text: re })
    expect(await text(/third/)).toBeDefined() // Next
    expect(await text(/No story in progress/)).toBeDefined()
    expect(await text(/1\/2 50%/)).toBeDefined()

    await ui.press({ key: 'tab-sprint' })
    expect(await text(/^ 1 dropped$/)).toBeDefined()
    expect(await text(/^dropped$/)).toBeDefined() // the story's status, in its own column
    expect(await text(/Second/)).toBeDefined()

    await ui.press({ key: 'tab-debt' })
    expect(await text(/Open review findings/)).toBeUndefined()
    // only the spec that is not dropped is listed outside the sprint
    expect(await text(/Specs outside the sprint \(1\)/)).toBeDefined()
    expect(await text(/9-2-live/)).toBeDefined()
    expect(await text(/9-1-gone/)).toBeUndefined()
    await ui.unmount()
  })
})

import { describe, expect, mock, test } from 'claude-code/testing'

import { FILES, ROOT, V7, V7_TICKET_FILES, fakeProject, mountPane, status, until } from './fixture'

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const gitStatusOf = (calls: string[][], root: string) => calls.filter(a => a[0] === 'git' && a[2] === root && a[3] === 'status').length
const ticketRuns = (calls: string[][]) => calls.filter(a => a.some(x => x.endsWith('tickets.py'))).length
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

describe('session start', () => {
  test('does not wait for the first refresh, and opens the pane from the project root alone', async ($, on) => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let held = 0
    const opened: string[] = []
    const tools: { name: string; description?: string; inputSchema?: any }[] = []
    fakeProject(on, FILES, ROOT, undefined, {
      opened,
      tools,
      run: async argv => {
        if (argv[0] === 'git') {
          held++
          await gate
        }
        return undefined
      },
    })

    // this would never return if session.start awaited the refresh
    await $.session.start(START)
    expect(opened).toEqual(['bmad'])
    expect(tools.map(t => t.name)).toEqual(['status'])
    await until(() => held > 0, 'the background refresh to start')

    // the pane shows the loading line until the snapshot is there
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'Loading BMAD…' })).toBeDefined()
    release()
    expect((await status($)).project).toBe('demo')
    await ui.unmount()
  })

  test('outside a BMAD project nothing opens by itself', async ($, on) => {
    const opened: string[] = []
    fakeProject(on, FILES, '/elsewhere', undefined, { opened })
    await $.session.start({ ...START, cwd: '/elsewhere' })
    expect(opened).toEqual([])
  })

  test('the tool says its default is the summary', async ($, on) => {
    const tools: { name: string; description?: string; inputSchema?: any }[] = []
    fakeProject(on, FILES, ROOT, undefined, { tools })
    await $.session.start(START)
    const tool = tools[0]!
    expect(tool.inputSchema.properties.section.enum).toEqual(['summary', 'all', 'project', 'sprint', 'loop', 'planning', 'quality', 'debt', 'modules', 'alerts'])
    expect(tool.description).toMatch(/summary/)
    expect(tool.description).toMatch(/`section`/)
    expect(tool.description!.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(3)
    await status($) // let the background refresh end before the test does
  })
})

describe('refresh requests that arrive while one runs', () => {
  test('schedule exactly one more run', async ($, on) => {
    let release!: () => void
    let gate: Promise<void> | undefined = new Promise<void>(r => (release = r))
    let held = 0
    const calls: string[][] = []
    fakeProject(on, FILES, ROOT, undefined, {
      calls,
      run: async argv => {
        if (gate && argv[0] === 'git' && argv[3] === 'status') {
          held++
          await gate
        }
        return undefined
      },
    })
    const first = status($, 'alerts')
    await until(() => held > 0, 'the first run to start')
    // three more while it is held
    const more = [status($, 'alerts'), status($, 'alerts'), status($, 'alerts')]
    await tick()
    gate = undefined
    release()
    await Promise.all([first, ...more])
    // the run in flight and one more for all three
    expect(gitStatusOf(calls, ROOT)).toBe(2)
  })

  test('calls one after the other each run', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, FILES, ROOT, undefined, { calls })
    await status($)
    await status($)
    expect(gitStatusOf(calls, ROOT)).toBe(2)
  })
})

describe('manual refresh', () => {
  test('ignores cached script output; timer reads and the tool do not', async ($, on) => {
    const calls: string[][] = []
    fakeProject(on, V7_TICKET_FILES, V7, undefined, { calls })
    await status($)
    expect(ticketRuns(calls)).toBe(1)
    await status($)
    expect(ticketRuns(calls)).toBe(1) // cached

    await $.command.run({ command: 'bmad-dashboard', args: 'refresh' } as never)
    expect(ticketRuns(calls)).toBe(2)
    await $.command.run({ command: 'bmad-dashboard', args: 'sprint' } as never)
    expect(ticketRuns(calls)).toBe(2) // opening a tab is not a manual refresh

    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'refresh' })
    expect(ticketRuns(calls)).toBe(3)
    await ui.unmount()
  })

  test('a fresh request that arrives while busy is kept for the run that follows', async ($, on) => {
    let release!: () => void
    let gate: Promise<void> | undefined
    let held = 0
    const calls: string[][] = []
    fakeProject(on, V7_TICKET_FILES, V7, undefined, {
      calls,
      run: async argv => {
        if (gate && argv[0] === 'git' && argv[3] === 'status') {
          held++
          await gate
        }
        return undefined
      },
    })
    await status($)
    expect(ticketRuns(calls)).toBe(1)
    gate = new Promise<void>(r => (release = r))
    const first = status($, 'alerts')
    await until(() => held > 0, 'the run to start')
    const manual = $.command.run({ command: 'bmad-dashboard', args: 'refresh' } as never)
    await tick()
    gate = undefined
    release()
    await Promise.all([first, manual])
    expect(ticketRuns(calls)).toBe(2)
  })
})

describe('timer', () => {
  async function started($: any, on: any, panes: () => string[], calls: string[][]) {
    fakeProject(on, FILES, ROOT, undefined, { calls, panes })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start(START)
    await until(() => gitStatusOf(calls, ROOT) === 1, 'the first refresh')
    await clock.settle()
    return clock
  }

  test('with the pane closed it refreshes at most once a minute, for the status line', async ($, on) => {
    const calls: string[][] = []
    const clock = await started($, on, () => [], calls)
    for (let i = 0; i < 3; i++) {
      await clock.advance(15_000)
      await tick()
      expect(gitStatusOf(calls, ROOT)).toBe(1)
    }
    await clock.advance(15_000)
    await until(() => gitStatusOf(calls, ROOT) === 2, 'the refresh after a minute')
    // and the minute starts over
    await clock.advance(15_000)
    await tick()
    expect(gitStatusOf(calls, ROOT)).toBe(2)
  })

  test('with the pane open it refreshes on every tick', async ($, on) => {
    const calls: string[][] = []
    const clock = await started($, on, () => ['bmad'], calls)
    await clock.advance(15_000)
    await until(() => gitStatusOf(calls, ROOT) === 2, 'the second refresh')
    await clock.advance(15_000)
    await until(() => gitStatusOf(calls, ROOT) === 3, 'the third refresh')
  })

  test('with the status line off and the pane closed it does not refresh', { options: { statusLine: false } }, async ($, on) => {
    const calls: string[][] = []
    const clock = await started($, on, () => [], calls)
    await clock.advance(120_000)
    await tick()
    expect(gitStatusOf(calls, ROOT)).toBe(1)
  })
})

describe('saving the project list', () => {
  type Saved = { root: string; name?: string; lastSeen: number }[]
  const open = (on: any, seed?: Saved) => {
    const writes: { key: string; value: unknown }[] = []
    const store = fakeProject(on, FILES, ROOT, undefined, { writes, store: seed && { projects: seed } })
    const projectWrites = () => writes.filter(w => w.key === 'projects').map(w => w.value as Saved)
    return { store, projectWrites }
  }

  test('only when the summary changed, or the saved lastSeen is old', async ($, on) => {
    const { projectWrites } = open(on)
    await status($)
    expect(projectWrites()).toHaveLength(1)
    await tick(10)
    await status($)
    await status($)
    expect(projectWrites()).toHaveLength(1) // nothing but lastSeen would have changed
  })

  test('a summary that differs is written', async ($, on) => {
    const { projectWrites } = open(on, [{ root: ROOT, name: 'old name', lastSeen: Date.now() }])
    await status($)
    expect(projectWrites()).toHaveLength(1)
    expect(projectWrites()[0]![0]!.name).toBe('demo')
  })

  test('an old lastSeen is written again', async ($, on) => {
    const { store, projectWrites } = open(on)
    await status($)
    const saved = projectWrites()[0]![0]!
    // the same summary, seen six minutes ago
    store.set('projects', [{ ...saved, lastSeen: Date.now() - 6 * 60_000 }])
    await status($)
    expect(projectWrites()).toHaveLength(2)
    expect(projectWrites()[1]![0]!.lastSeen).toBeGreaterThan(Date.now() - 60_000)
  })

  test('over 200 projects the list is cut to the most recently seen', async ($, on) => {
    const many = Array.from({ length: 205 }, (_, i) => ({ root: `/p/${i}`, name: `p${i}`, lastSeen: i === 0 ? 0 : 1000 + i }))
    const { projectWrites } = open(on, many)
    await status($)
    const list = projectWrites()[0]!
    expect(list).toHaveLength(200)
    expect(list[0]!.root).toBe(ROOT)
    expect(list.some(p => p.root === '/p/0')).toBe(false) // the never-seen one is cut first
    expect(list.some(p => p.root === '/p/204')).toBe(true)
  })
})

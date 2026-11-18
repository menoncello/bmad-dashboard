import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { BmadProjectSummary, BmadScanResult, BmadSnapshot } from '../types'
import { collect, emptySnapshot, findRoot } from './collect'
import { alerts, capProjects, currentEpic, scanDirsFor, scanText, shouldStore, statusLine, summaryOf, toolSummary } from './derive'
import { Debt, Loop, Modules, Overview, Planning, Projects, Quality, Sprint } from './tabs'
import type { Ctx, Options } from './tabs'

type $ = EngineInterface

const PANE = 'bmad'
const TITLE = 'BMAD'
const snapshot = atom({ plugin: 'bmad-dashboard', key: 'snapshot' } as const, null)
const tab = atom({ plugin: 'bmad-dashboard', key: 'tab' } as const, 'overview')
const epicSel = atom({ plugin: 'bmad-dashboard', key: 'epic' } as const, 0)
const loading = atom({ plugin: 'bmad-dashboard', key: 'loading' } as const, false)
const projects = atom({ plugin: 'bmad-dashboard', key: 'projects' } as const, [])
const rootSel = atom({ plugin: 'bmad-dashboard', key: 'root' } as const, '')
const scan = atom({ plugin: 'bmad-dashboard', key: 'scan' } as const, { running: false })

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

// ---------- collection ----------

// With the pane closed the timer only refreshes the status line, and that is slow news.
const CLOSED_REFRESH_MS = 60_000

let inflight: Promise<void> | undefined
let rerun: { fresh: boolean } | undefined
let lastStart = 0
let scanning: Promise<BmadScanResult> | undefined

async function nowMs($: $): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// One refresh at a time. A call that arrives while one runs does not start a second:
// it asks for exactly one more run after the current one, and resolves when that is done.
function refresh($: $, options: Options, opts: { fresh?: boolean } = {}): Promise<void> {
  if (inflight) {
    rerun = { fresh: (rerun?.fresh ?? false) || opts.fresh === true }
    return inflight
  }
  const run = (async () => {
    try {
      let fresh = opts.fresh === true
      for (;;) {
        lastStart = await nowMs($)
        await refreshOnce($, options, fresh)
        const again = rerun
        rerun = undefined
        if (!again) return
        fresh = again.fresh
      }
    } finally {
      inflight = undefined
      rerun = undefined
    }
  })()
  inflight = run
  return run
}

// the timer and session start must not fail on a refresh that threw
function kick($: $, options: Options, opts?: { fresh?: boolean }) {
  refresh($, options, opts).catch(() => {})
}

async function refreshOnce($: $, options: Options, fresh: boolean) {
  try {
    const cwd = await $.session.cwd()
    // only the session's own project may run its scripts (tickets.py)
    const sessionRoot = await findRoot($, cwd)
    let root = await read($, rootSel)
    if (!root) {
      root = sessionRoot ?? ''
      if (root) await update($, rootSel, () => root)
    }
    if (!root) {
      await update($, snapshot, () => emptySnapshot(cwd))
      return
    }
    await update($, loading, () => true)
    let snap: BmadSnapshot
    try {
      snap = await collect($, root, { runScripts: root === sessionRoot, fresh })
    } catch (err) {
      snap = { ...emptySnapshot(root), found: true, errors: [`collection failed: ${String(err)}`] }
    }
    // the user may have switched project while this one was being read
    const selected = (await read($, rootSel)) || sessionRoot || ''
    if (selected !== root) {
      rerun ??= { fresh: false }
      return
    }
    await update($, snapshot, () => snap)
    if (options.statusLine) $.ui.status(statusLine(snap))
    await remember($, snap)
  } finally {
    await update($, loading, () => false)
  }
}

async function exists($: $, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return true // cannot tell: keep the entry
  }
}

async function savedProjects($: $): Promise<BmadProjectSummary[]> {
  return ((await $.store.get('projects')) as BmadProjectSummary[] | undefined) ?? []
}

async function remember($: $, s: BmadSnapshot) {
  if (!s.found) return
  const saved = await savedProjects($)
  const entry = summaryOf(s)
  // lastSeen changes on every refresh; the store is written when something else did, or now and then
  if (!shouldStore(saved.find(p => p.root === s.root), entry)) return
  const next = capProjects([entry, ...saved.filter(p => p.root !== s.root)])
  await $.store.set('projects', next)
  await update($, projects, () => next)
}

// find skips node_modules and dot folders without walking into them, and does not
// descend into a _bmad it found
function findArgv(dir: string): string[] {
  return ['find', dir, '-mindepth', '1', '-maxdepth', '5', '(', '-type', 'd', '(', '-name', 'node_modules', '-o', '-name', '.*', ')', ')', '-prune', '-o', '-type', 'd', '-name', '_bmad', '-print', '-prune']
}

function scanProjects($: $, dirs: string[]): Promise<BmadScanResult> {
  if (scanning) return scanning
  const run = (async () => {
    await update($, scan, () => ({ running: true }))
    try {
      const found = new Set<string>()
      for (const dir of dirs) {
        try {
          const r = await $.process.run(findArgv(dir), { timeoutMs: 30000 })
          for (const line of r.stdout.split('\n')) if (line.endsWith('/_bmad')) found.add(line.slice(0, -'/_bmad'.length))
        } catch {
          // a folder we cannot read
        }
      }
      const saved = await savedProjects($)
      // a saved project whose _bmad folder is gone is dropped
      const kept: BmadProjectSummary[] = []
      for (const p of saved) {
        const there = found.has(p.root) || (await exists($, `${p.root}/_bmad`))
        if (there) kept.push(p)
      }
      const known = new Set(saved.map(p => p.root))
      const added = [...found].filter(r => !known.has(r))
      const next = capProjects([...kept, ...added.map(root => ({ root, name: root.split('/').pop(), lastSeen: 0 }))])
      await $.store.set('projects', next)
      await update($, projects, () => next)
      const result = { found: found.size, added: added.length, removed: saved.length - kept.length }
      await update($, scan, () => ({ running: false, result }))
      return result
    } catch (err) {
      await update($, scan, () => ({ running: false }))
      throw err
    } finally {
      scanning = undefined
    }
  })()
  scanning = run
  return run
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
        'Where the BMAD project in the working directory stands: version, modules, git, sprint counts, epics with progress, stories in progress, the next story, the live bmad-loop run, alerts and counts of open pending work. The default section is this summary. Pass `section` for the detail of one part (project, sprint, loop, planning, quality, debt, modules, alerts), or `all` for the whole snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['summary', 'all', 'project', 'sprint', 'loop', 'planning', 'quality', 'debt', 'modules', 'alerts'],
            description: 'Which part to return (default summary).',
          },
        },
      },
    })
    const saved = (await $.store.get('projects')) as BmadProjectSummary[] | undefined
    if (saved) await update($, projects, () => saved)
    // opening the pane needs only to know there is a project; the first read runs in the background
    if (options.autoOpen && (await findRoot($, await $.session.cwd()))) void $.ui.open({ id: PANE, title: TITLE })
    kick($, options)
    $.clock.every(options.refreshSeconds * 1000, () => {
      void (async () => {
        const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
        if (isOpen) return kick($, options)
        // closed: only the status line needs it, and it can wait
        if (options.statusLine && (await nowMs($)) - lastStart >= CLOSED_REFRESH_MS) kick($, options)
      })().catch(() => {})
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
      const dirs = scanDirsFor(options.scanRoots, s?.root || (await $.session.cwd()))
      const r = await scanProjects($, dirs)
      return { text: `Scanned ${dirs.join(', ')}: ${scanText(r)}.` }
    }
    const t = TABS.find(x => x.id === arg || x.label.toLowerCase() === arg || x.key === arg)
    if (t) await update($, tab, () => t.id)
    await refresh($, options, { fresh: arg === 'refresh' })
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
    const section = String((e as { input?: { section?: string } }).input?.section ?? (e as { section?: string }).section ?? 'summary')
    const pick: Record<string, () => unknown> = {
      summary: () => toolSummary(s),
      all: () => s,
      project: () => ({ project: s.project, modules: s.modules, agents: s.agents, git: s.git, paths: s.paths }),
      sprint: () => ({ sprint: s.sprint, sprintNote: s.sprintNote, storiesOutsideSprint: s.storiesOutsideSprint }),
      loop: () => s.loop,
      planning: () => ({ planning: s.planning, workflowStatus: s.workflowStatus, inProgressSessions: s.inProgressSessions, creative: s.creative, wds: s.wds, orchestrations: s.orchestrations }),
      quality: () => ({ summary: s.qualitySummary, buildAuto: s.buildAuto, recent: s.quality.slice(0, 40) }),
      debt: () => ({ deferred: s.deferred, actionItems: s.sprint?.actionItems, changeProposals: s.changeProposals }),
      modules: () => ({ modules: s.modules, agents: s.agents, skills: s.skills, builder: s.builder }),
      alerts: () => alerts(s),
    }
    return { result: JSON.stringify((pick[section] ?? pick.summary!)()) }
  }).catch(() => ({ result: 'bmad-dashboard could not read the BMAD project.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const s = await read($, snapshot)
    const current = await read($, tab)
    const cols = Math.max(30, Number((e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80))
    const isLoading = await read($, loading)
    if (!s) return <Text dimColor>Loading BMAD…</Text>
    const list = await read($, projects)
    const c: Ctx = {
      el,
      s,
      cols,
      options,
      scan: await read($, scan),
      actions: {
        scan: dirs => void scanProjects($, dirs).catch(() => {}),
        switchRoot: root => void switchRoot($, root, options).catch(() => {}),
        selectEpic: num => void update($, epicSel, () => num),
      },
    }

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TABS.map(t => (
          <Button key={`tab-${t.id}`} plain hotkey={t.key} onPress={() => update($, tab, () => t.id)}>
            <Text color={current === t.id ? 'claude' : undefined} bold={current === t.id} dimColor={current !== t.id}>
              {t.label}
            </Text>
          </Button>
        ))}
        <Button key="refresh" plain hotkey="r" onPress={() => refresh($, options, { fresh: true })}>
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
    if (current === 'sprint') body = Sprint(c, await read($, epicSel))
    else if (current === 'loop') body = Loop(c)
    else if (current === 'planning') body = Planning(c)
    else if (current === 'quality') body = Quality(c)
    else if (current === 'debt') body = Debt(c)
    else if (current === 'modules') body = Modules(c)
    else if (current === 'projects') body = Projects(c, list)
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

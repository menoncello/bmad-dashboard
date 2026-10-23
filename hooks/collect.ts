import type { EngineInterface, FsEntry } from 'claude-code'

import type {
  BmadActionItem,
  BmadAgent,
  BmadArtifact,
  BmadDeferred,
  BmadEpic,
  BmadGit,
  BmadLoop,
  BmadLoopEvent,
  BmadLoopRun,
  BmadLoopTask,
  BmadModule,
  BmadSkill,
  BmadSnapshot,
  BmadStory,
} from '../types'
import { arr, deepMerge, frontmatter, obj, parseCsv, parseToml, parseYaml, str } from './parse'
import type { Doc, Json, Obj } from './parse'
import { collectAutomator, collectBuilder, collectWds, qualitySummary, reviewScore, workflowStatus } from './modules'

type $ = EngineInterface

// Parsed files keyed by path, reused while mtime and size hold. A module
// variable on purpose: a reload starts it over, which is only a cold cache.
const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>()

async function readText($: $, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function list($: $, dir: string): Promise<FsEntry[]> {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

async function cached<T>(
  $: $,
  path: string,
  entry: { mtimeMs: number; size: number } | undefined,
  parse: (text: string) => T,
  tag: string = parse.name,
): Promise<T | undefined> {
  let meta = entry
  if (!meta) {
    try {
      const st = await $.fs.stat(path)
      meta = { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return undefined
    }
  }
  const id = `${tag}|${path}`
  const hit = cache.get(id)
  if (hit && hit.mtimeMs === meta.mtimeMs && hit.size === meta.size) return hit.value as T
  if (meta.size > 4 * 1024 * 1024) return undefined
  const text = await readText($, path)
  if (text === undefined) return undefined
  let value: T
  try {
    value = parse(text)
  } catch {
    return undefined
  }
  cache.set(id, { mtimeMs: meta.mtimeMs, size: meta.size, value })
  return value
}

type Walked = { path: string; rel: string; entry: FsEntry }

async function walk($: $, dir: string, depth: number, skip: (name: string) => boolean, out: Walked[] = [], rel = ''): Promise<Walked[]> {
  if (out.length > 3000) return out
  for (const entry of await list($, dir)) {
    if (skip(entry.name)) continue
    const path = `${dir}/${entry.name}`
    const r = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.kind === 'dir') {
      if (depth > 0) await walk($, path, depth - 1, skip, out, r)
    } else if (entry.kind === 'file') out.push({ path, rel: r, entry })
  }
  return out
}

export async function findRoot($: $, cwd: string): Promise<string | undefined> {
  let dir = cwd.replace(/\/+$/, '')
  for (let i = 0; i < 12 && dir; i++) {
    if (await $.fs.exists(`${dir}/_bmad`)) return dir
    const cut = dir.lastIndexOf('/')
    if (cut <= 0) break
    dir = dir.slice(0, cut)
  }
  return undefined
}

function heading(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body)
  return m?.[1].trim()
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const DATE_KEYS = ['updated', 'lastSaved', 'last_updated', 'completedAt', 'date', 'created']

function artifactOf(path: string, kind: string, doc: Doc, mtimeMs: number): BmadArtifact {
  const fm = doc.fm
  const steps = arr(fm.stepsCompleted ?? fm.sections_completed)
  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(fm)) {
    const s = str(v)
    if (s !== undefined && s.length <= 120) extra[k] = s
    else if (Array.isArray(v) && v.every(x => typeof x !== 'object')) extra[k] = v.join(', ').slice(0, 160)
  }
  if (/Quality Score/i.test(doc.body)) Object.assign(extra, reviewScore(doc.body))
  let verdict = str(fm.verdict ?? fm.gate ?? fm.gate_decision ?? fm.gateDecision ?? fm.decision ?? fm.overall_status)
  if (!verdict) {
    const m = /(?:gate decision|decision|verdict|overall status)\s*[:*]*\s*\**\s*(PASS|CONCERNS|FAIL|WAIVED|accepted-with-open-items|accepted|rejected)\b/i.exec(doc.body)
    if (m) verdict = m[1].toUpperCase() === m[1] ? m[1] : m[1].toLowerCase()
  }
  const created = str(fm.created)
  return {
    path,
    kind,
    title: str(fm.title ?? fm.name ?? fm.topic ?? fm.session_topic ?? fm.research_topic) ?? heading(doc.body),
    status: str(fm.status),
    updated: DATE_KEYS.map(k => str(fm[k])).find(Boolean),
    created,
    steps: steps.length || undefined,
    lastStep: str(fm.lastStep),
    workflow: str(fm.workflowType ?? fm.type),
    verdict,
    mtimeMs,
    extra,
  }
}

function resolvePath(raw: string | undefined, root: string, vars: Record<string, string>): string | undefined {
  if (!raw) return undefined
  let p = raw.replace(/\{project-root\}/g, root)
  for (const [k, v] of Object.entries(vars)) p = p.split(`{${k}}`).join(v)
  if (!p.startsWith('/')) p = `${root}/${p.replace(/^\.\//, '')}`
  return p.replace(/\/+$/, '')
}

// ---------- stories ----------

const STORY_FILE = /^(\d+)-(\d+[a-z]?)-.+\.md$/
const SPEC_FILE = /^spec-(.+)\.md$/

function countTasks(body: string, format: 'spec' | 'legacy') {
  const section = format === 'spec' ? /^## Tasks/m : /^## Tasks/m
  const start = body.search(section)
  let done = 0
  let total = 0
  let reviewOpen = 0
  let reviewDone = 0
  const lines = body.split('\n')
  let inTasks = false
  let offset = 0
  for (const line of lines) {
    if (offset >= start && start >= 0 && /^## Tasks/.test(line)) inTasks = true
    else if (inTasks && /^## /.test(line)) inTasks = false
    offset += line.length + 1
    const box = /^\s*[-*] \[( |x|X)\]/.exec(line)
    if (!box) continue
    const checked = box[1] !== ' '
    if (/\[Review\]/.test(line)) {
      if (checked) reviewDone++
      else reviewOpen++
      continue
    }
    if (inTasks) {
      total++
      if (checked) done++
    }
  }
  return { tasksDone: done, tasksTotal: total, reviewOpen, reviewDone }
}

type StoryFile = Omit<BmadStory, 'key' | 'epic' | 'num' | 'status'> & { status?: string; title?: string }

function parseStory(text: string, format: 'spec' | 'legacy'): StoryFile {
  const doc = frontmatter(text)
  const fm = doc.fm
  let status = str(fm.status)
  if (!status) status = /^Status:\s*(\S+)/m.exec(doc.body)?.[1]
  const autoRun = /^## Auto Run Result[\s\S]*?^Status:\s*(\S+)/m.exec(doc.body)?.[1]
  const title = str(fm.title) ?? heading(doc.body)?.replace(/^Story\s+\d+\.\d+[a-z]?:\s*/, '')
  return {
    format,
    fileStatus: autoRun && status !== 'done' ? `${status ?? ''} (auto: ${autoRun})`.trim() : status,
    status,
    title,
    type: str(fm.type),
    route: str(fm.route),
    ...countTasks(doc.body, format),
  }
}

function storyNumbers(key: string): { epic: number; num: string } | undefined {
  const m = /^(?:spec-)?(?:dw-)?(\d+)-(\d+[a-z]?)(?:-|$)/.exec(key)
  return m ? { epic: Number(m[1]), num: m[2] } : undefined
}

// ---------- sprint ----------

const SPRINT_ALIASES: Record<string, string> = { drafted: 'ready-for-dev', contexted: 'in-progress' }

function parseEpicTitles(text: string): { epics: Map<number, string>; stories: Map<string, string> } {
  const epics = new Map<number, string>()
  const stories = new Map<string, string>()
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced
    if (fenced) continue
    const e = /^#{1,3}\s*Epic\s+(\d+)\s*:?\s*(.*?)\s*#*\s*$/.exec(line)
    if (e) {
      if (!epics.has(Number(e[1])) && e[2]) epics.set(Number(e[1]), e[2])
      continue
    }
    const s = /^#{2,4}\s*Story\s+(\d+)\.(\d+[a-z]?)\s*:?\s*(.*?)\s*#*\s*$/.exec(line)
    if (s && s[3]) stories.set(`${s[1]}-${s[2]}`, s[3])
  }
  return { epics, stories }
}

function parseSprintDate(s: string | undefined): number | undefined {
  if (!s) return undefined
  let m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(s)
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
  return undefined
}

// ---------- deferred work ----------

function parseDeferred(text: string): BmadDeferred[] {
  const out: BmadDeferred[] = []
  const blocks = text.split(/^###\s+/m).slice(1)
  for (const b of blocks) {
    const head = /^(DW-\d+)\s*:?\s*(.*)$/m.exec(b.split('\n')[0])
    if (!head) continue
    const field = (name: string) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*(.+)$`, 'mi').exec(b)?.[1].trim()
    const status = field('status') ?? 'open'
    out.push({
      id: head[1],
      title: head[2].trim(),
      severity: field('severity'),
      status: /^done|resolved|closed/i.test(status) ? 'done' : status.split(/\s/)[0].toLowerCase(),
      origin: field('origin'),
    })
  }
  if (out.length === 0) {
    // code-review form: "## Deferred from: ..." followed by bullets
    let n = 0
    for (const line of text.split('\n')) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line)
      if (!m || /^\s*[-*]\s+(source_spec|summary|evidence)\s*:/.test(line)) continue
      n++
      out.push({ id: `#${n}`, title: m[1].replace(/\*\*/g, '').slice(0, 140), status: /RESOLVED/i.test(m[1]) ? 'done' : 'open' })
    }
  }
  return out
}

// ---------- bmad-loop ----------

const TERMINAL_PHASES = new Set(['done', 'deferred', 'escalated', 'awaiting-operator'])

function tokensOf(t: Obj, weight: number): { raw: number; weighted: number } {
  const n = (k: string) => Number(t[k] ?? 0) || 0
  const input = n('input_tokens')
  const output = n('output_tokens')
  const cr = n('cache_read_tokens')
  const cc = n('cache_creation_tokens')
  return { raw: input + output + cr + cc, weighted: input + output + cc + Math.round(cr * weight) }
}

async function pidAlive($: $, pid: number): Promise<boolean> {
  try {
    const r = await $.process.run(['ps', '-p', String(pid), '-o', 'command='], { timeoutMs: 5000 })
    return r.exitCode === 0 && r.stdout.trim().length > 0
  } catch {
    return false
  }
}

function eventDetail(ev: Obj): string | undefined {
  const keys = ['status', 'reason', 'stage', 'action', 'commit', 'error', 'message', 'workflow', 'role', 'question', 'next', 'dw_id', 'task_id']
  const parts: string[] = []
  for (const k of keys) {
    const v = str(ev[k])
    if (v) parts.push(k === 'status' || k === 'reason' || k === 'message' ? v : `${k}=${v}`)
  }
  return parts.join(' ').slice(0, 200) || undefined
}

async function collectRun($: $, dir: string, runId: string, weight: number): Promise<BmadLoopRun> {
  const st = obj((await cached($, `${dir}/state.json`, undefined, t => JSON.parse(t) as Json, 'json')) ?? {})
  const pidText = (await readText($, `${dir}/engine.pid`))?.trim()
  const pid = pidText ? Number(pidText.split(/\s+/)[0]) : undefined
  const attention = ((await readText($, `${dir}/ATTENTION`)) ?? '').split('\n').filter(Boolean).slice(-8)
  const stopReq = await readText($, `${dir}/stop-request.json`)
  let stopRequested: string | undefined
  if (stopReq) {
    try {
      stopRequested = str(obj(JSON.parse(stopReq) as Json).mode) ?? 'graceful'
    } catch {
      stopRequested = 'graceful'
    }
  }

  let status = 'unknown'
  if (st.finished === true) status = 'finished'
  else if (st.paused_reason) status = 'paused'
  else if (st.stopped === true) status = 'stopped'
  else if (st.crashed === true) status = 'crashed'
  else if (pid) status = (await pidAlive($, pid)) ? 'running' : 'interrupted'
  if (status === 'running' && stopRequested) status = 'stopping'

  const tasks: BmadLoopTask[] = []
  const counts: Record<string, number> = {}
  let tokensRaw = 0
  let tokensWeighted = 0
  let currentStory: string | undefined
  let currentPhase: string | undefined
  for (const [key, raw] of Object.entries(obj(st.tasks))) {
    const t = obj(raw)
    const tok = tokensOf(obj(t.tokens), weight)
    tokensRaw += tok.raw
    tokensWeighted += tok.weighted
    const phase = str(t.phase) ?? 'pending'
    counts[phase] = (counts[phase] ?? 0) + 1
    if (!TERMINAL_PHASES.has(phase) && phase !== 'pending') {
      currentStory = key
      currentPhase = phase
    }
    tasks.push({
      storyKey: key,
      epic: str(t.epic),
      phase,
      attempt: Number(t.attempt ?? 0) || undefined,
      reviewCycle: Number(t.review_cycle ?? 0) || undefined,
      generation: Number(t.generation ?? 0) || undefined,
      tokensRaw: tok.raw,
      tokensWeighted: tok.weighted,
      commit: str(t.commit_sha)?.slice(0, 10),
      deferReason: str(t.defer_reason),
      sessions: arr(t.sessions).length,
    })
  }

  // journal tail: the last events, the open session, idle and pending decisions
  const events: BmadLoopEvent[] = []
  let activeTask: string | undefined
  let activeRole: string | undefined
  let activeAdapter: string | undefined
  let idle = false
  let pendingDecision: string | undefined
  try {
    const r = await $.process.run(['tail', '-n', '200', `${dir}/journal.jsonl`], { timeoutMs: 5000 })
    const open = new Map<string, Obj>()
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue
      let ev: Obj
      try {
        ev = obj(JSON.parse(line) as Json)
      } catch {
        continue
      }
      const kind = str(ev.kind) ?? '?'
      const task = str(ev.task_id)
      if (kind === 'session-start' && task) open.set(task, ev)
      if (kind === 'session-end' && task) open.delete(task)
      if (kind === 'session-idle') idle = true
      if (kind === 'session-active' || kind === 'session-start') idle = false
      if (kind === 'decision-pending') pendingDecision = str(ev.question) ?? str(ev.dw_id)
      if (kind === 'decision-answered') pendingDecision = undefined
      events.push({ ts: Number(ev.ts ?? 0), kind, story: str(ev.story_key), detail: eventDetail(ev) })
    }
    const last = [...open.values()].pop()
    if (last) {
      activeTask = str(last.task_id)
      activeRole = str(last.role)
      activeAdapter = [str(last.adapter), str(last.model)].filter(Boolean).join(' ')
    }
  } catch {
    // no journal yet
  }

  let heartbeatAgeS: number | undefined
  let remainingS: number | undefined
  if (activeTask) {
    const hb = await readText($, `${dir}/tasks/${activeTask}/heartbeat.json`)
    if (hb) {
      try {
        const h = obj(JSON.parse(hb) as Json)
        heartbeatAgeS = Math.round(Date.now() / 1000 - Number(h.ts ?? 0))
        remainingS = Number(h.remaining_s ?? 0) || undefined
      } catch {
        // half-written heartbeat
      }
    }
  }

  return {
    runId,
    ref: runId.slice(-4),
    runType: str(st.run_type),
    source: str(st.source),
    startedAt: str(st.started_at),
    status,
    pid,
    pausedStage: str(st.paused_stage),
    pausedReason: str(st.paused_reason),
    pausedStory: str(st.paused_story_key),
    crashError: str(st.crash_error),
    stopRequested,
    currentStory: currentStory ?? str(st.paused_story_key),
    currentPhase,
    activeTask,
    activeRole,
    activeAdapter: activeAdapter || undefined,
    heartbeatAgeS,
    remainingS,
    idle,
    pendingDecision,
    tokensRaw,
    tokensWeighted,
    attention,
    tasks,
    events: events.slice(-40),
    counts,
  }
}

async function collectLoop($: $, root: string, hasModule: boolean): Promise<BmadLoop> {
  const base = `${root}/.bmad-loop`
  if (!(await $.fs.exists(base))) return { installed: hasModule, runs: [] }
  const policyRaw = await cached($, `${base}/policy.toml`, undefined, parseToml)
  const policy: Record<string, string> = {}
  const pick = (section: string, keys: string[]) => {
    const t = obj(policyRaw?.[section])
    for (const k of keys) {
      const v = t[k]
      if (v !== undefined && typeof v !== 'object') policy[`${section}.${k}`] = String(v)
      else if (Array.isArray(v)) policy[`${section}.${k}`] = v.join(', ')
    }
  }
  pick('gates', ['mode', 'retrospective'])
  pick('limits', ['max_dev_attempts', 'max_review_cycles', 'session_timeout_min', 'max_tokens_per_story', 'max_tokens_per_session', 'session_budget_mode', 'cache_read_weight'])
  pick('review', ['enabled', 'trigger'])
  pick('adapter', ['name', 'model', 'effort'])
  pick('sweep', ['auto', 'max_bundles'])
  pick('scm', ['isolation', 'branch_per', 'merge_strategy'])
  pick('plugins', ['enabled'])
  const weight = Number(policy['limits.cache_read_weight'] ?? 0.1) || 0.1

  const runIds = (await list($, `${base}/runs`))
    .filter(e => e.kind === 'dir' && /^\d{8}-\d{6}-/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse()
    .slice(0, 6)
  const runs: BmadLoopRun[] = []
  for (const id of runIds) runs.push(await collectRun($, `${base}/runs/${id}`, id, weight))
  return { installed: true, policy, runs }
}

// ---------- git ----------

async function collectGit($: $, root: string): Promise<BmadGit | undefined> {
  try {
    const s = await $.process.run(['git', '-C', root, 'status', '--porcelain=v1', '-b'], { timeoutMs: 8000 })
    if (s.exitCode !== 0) return undefined
    const [head, ...rest] = s.stdout.split('\n')
    const b = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?,? ?(?:behind (\d+))?\])?/.exec(head ?? '')
    const log = await $.process.run(['git', '-C', root, 'log', '-1', '--format=%h %s%x1f%cr'], { timeoutMs: 8000 })
    const [lastCommit, lastCommitAgo] = log.stdout.trim().split('\x1f')
    return {
      branch: b?.[1],
      ahead: b?.[2] ? Number(b[2]) : undefined,
      behind: b?.[3] ? Number(b[3]) : undefined,
      dirty: rest.filter(l => l.trim()).length,
      lastCommit: lastCommit || undefined,
      lastCommitAgo: lastCommitAgo || undefined,
    }
  } catch {
    return undefined
  }
}

// ---------- artifacts ----------

function planningKind(rel: string): string {
  const r = rel.toLowerCase()
  if (r.includes('sprint-change-proposal')) return 'change-proposal'
  if (r.includes('readiness')) return 'readiness'
  if (r.includes('prfaq')) return 'prfaq'
  if (r.includes('brief')) return 'brief'
  if (r.includes('prd')) return 'prd'
  if (r.includes('ux')) return 'ux'
  if (r.includes('architecture')) return 'architecture'
  if (r.includes('research')) return 'research'
  if (r.includes('epic')) return 'epics'
  if (r.includes('project-context')) return 'project-context'
  if (r.includes('gdd') || r.includes('game-design')) return 'gdd'
  if (r.includes('game-brief')) return 'game-brief'
  if (r.includes('narrative')) return 'narrative'
  return 'doc'
}

function qualityKind(rel: string): string {
  const r = rel.toLowerCase()
  if (r.includes('atdd')) return 'atdd'
  if (r.includes('automation')) return 'automation'
  if (r.includes('trace')) return 'trace'
  if (r.includes('nfr')) return 'nfr'
  if (r.includes('gate')) return 'gate'
  if (r.includes('test-design')) return 'test-design'
  if (r.includes('review')) return 'test-review'
  if (r.includes('framework')) return 'framework'
  if (r.includes('ci')) return 'ci'
  return 'test-doc'
}

const SKIP_DIRS = new Set(['.working', 'mockups', 'node_modules', '.git', 'assets', 'images'])

async function docArtifacts($: $, dir: string, depth: number, kindOf: (rel: string) => string, filter: (rel: string) => boolean = () => true): Promise<BmadArtifact[]> {
  const files = await walk($, dir, depth, n => SKIP_DIRS.has(n))
  const out: BmadArtifact[] = []
  for (const f of files) {
    if (!/\.(md|yaml|yml)$/i.test(f.rel) || f.rel.endsWith('.memlog.md') || !filter(f.rel)) continue
    const doc = await cached($, f.path, f.entry, t => (/\.ya?ml$/i.test(f.rel) ? { fm: obj(parseYaml(t)), body: '' } : frontmatter(t)), 'doc')
    if (!doc) continue
    out.push(artifactOf(f.rel, kindOf(f.rel), doc, f.entry.mtimeMs))
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// ---------- v7 install ----------

const skillOf = (r: Record<string, string>): BmadSkill => ({
  name: r['display-name'] || r.skill,
  module: r.module,
  description: r.description,
  phase: r.phase,
  menuCode: r['menu-code'],
  required: /^true|yes$/i.test(r.required ?? ''),
})

// v7 has no manifest: modules are the [bmod] records of the skills' bmod.toml
// files, the skills come from each module's module-help.csv.
async function collectV7($: $, root: string): Promise<{ version?: string; modules: BmadModule[]; skills: BmadSkill[] }> {
  const modules: BmadModule[] = []
  for (const e of await list($, `${root}/.agents/skills`)) {
    if (e.kind === 'file') continue // a symlinked skill folder lists as 'other'
    const b = obj((await cached($, `${root}/.agents/skills/${e.name}/bmod.toml`, undefined, parseToml))?.bmod)
    const name = str(b.code)
    if (name) modules.push({ name, version: str(b.version), source: str(b.update_source) })
  }
  modules.sort((a, b) => a.name.localeCompare(b.name))
  const skills: BmadSkill[] = []
  for (const e of await list($, `${root}/_bmad`)) {
    if (e.kind !== 'dir' || e.name.startsWith('_')) continue
    const rows = (await cached($, `${root}/_bmad/${e.name}/module-help.csv`, undefined, parseCsv)) ?? []
    for (const r of rows) if (r.skill && r.skill !== '_meta') skills.push(skillOf(r))
  }
  return { version: (modules.find(m => m.name === 'method') ?? modules.find(m => m.version))?.version, modules, skills }
}

// ---------- v7 tickets ----------

const TICKETS = '_bmad/method/scripts/tickets.py'

// The ticket rules stay in the project's own script; this only maps its JSON
// onto the sprint shape. Epic titles are not in that JSON, tickets.toml has them.
async function collectTickets($: $, root: string, output: string, initiative: string | undefined, errors: string[]): Promise<BmadSnapshot['sprint']> {
  if (!initiative) return undefined
  const file = `${output}/${initiative}/tickets/tickets.toml`
  const plan = await cached($, file, undefined, parseToml)
  if (!plan) return undefined
  const script = `${root}/${TICKETS}`
  if (!(await $.fs.exists(script))) {
    errors.push(`${TICKETS} not found`)
    return undefined
  }
  // the script needs python >= 3.11; uv reads its header and finds one
  let stdout: string | undefined
  let failure: string | undefined
  for (const cmd of [['python3'], ['uv', 'run']]) {
    try {
      const r = await $.process.run([...cmd, script, '--project-root', root, 'status'], { cwd: root, timeoutMs: 15000 })
      if (r.exitCode === 0) {
        stdout = r.stdout
        break
      }
      failure ??= r.stderr.trim().split('\n').pop()
    } catch (e) {
      failure ??= String((e as Error)?.message ?? e)
    }
  }
  if (stdout === undefined) {
    errors.push(`tickets.py failed: ${failure || 'no output'}`.slice(0, 160))
    return undefined
  }
  let status: Obj
  try {
    status = obj(JSON.parse(stdout) as Json)
  } catch {
    errors.push('tickets.py did not print JSON')
    return undefined
  }

  const titles = new Map(arr(plan.epic).map(e => [str(obj(e).slug), str(obj(e).title)]))
  const epics = new Map<string, BmadEpic>()
  for (const e of arr(status.epics).map(obj)) {
    const slug = str(e.slug) ?? ''
    epics.set(slug, { num: Number(e.id), title: titles.get(slug) ?? slug, status: str(e.status) || 'backlog', stories: [] })
  }
  const counts: Record<string, number> = {}
  for (const t of arr(status.tickets).map(obj)) {
    const ep = epics.get(str(t.epic) ?? '')
    if (!ep) continue
    const state = str(t.state) ?? 'backlog'
    const st = state === 'planned' ? 'backlog' : state
    counts[st] = (counts[st] ?? 0) + 1
    ep.stories.push({
      key: str(t.ref) ?? `${ep.num}.${t.id}`,
      epic: ep.num,
      num: str(t.id) ?? '',
      title: str(t.title),
      status: st,
      type: t.type === 'story' ? undefined : str(t.type),
      risk: str(t.risk) || undefined,
      blockedReason: str(t.blocked_reason) || undefined,
    })
  }
  return {
    file: file.slice(root.length + 1),
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
    stale: false,
    counts,
    epics: [...epics.values()].sort((a, b) => a.num - b.num),
    actionItems: [],
  }
}

// ---------- the snapshot ----------

export async function collect($: $, root: string): Promise<BmadSnapshot> {
  const started = Date.now()
  const errors: string[] = []
  const bmad = `${root}/_bmad`

  // config: the TOML layers, then the flat per-module YAML as a fallback
  let config: Obj = {}
  for (const f of ['config.toml', 'config.user.toml', 'custom/config.toml', 'custom/config.user.toml']) {
    const t = await cached($, `${bmad}/${f}`, undefined, parseToml)
    if (t) config = deepMerge(config, t)
  }
  let flat: Obj = {}
  for (const e of await list($, bmad)) {
    if (e.kind !== 'dir' || e.name.startsWith('_')) continue
    const y = await cached($, `${bmad}/${e.name}/config.yaml`, undefined, t => obj(parseYaml(t)), 'yamlObj')
    if (y) flat = { ...y, ...flat }
  }
  const core = obj(config.core)
  const modsCfg = obj(config.modules)
  const val = (k: string, ...sections: string[]): string | undefined => {
    for (const s of sections) {
      const v = str(obj(modsCfg[s])[k])
      if (v) return v
    }
    return str(core[k]) ?? str(flat[k])
  }

  const output = resolvePath(val('output_folder') ?? '_bmad-output', root, {})!
  const vars = { output_folder: output, 'config_source:output_folder': output }
  const paths: Record<string, string> = { root, output }
  const setPath = (name: string, raw: string | undefined, fallback: string) => {
    paths[name] = resolvePath(raw, root, vars) ?? `${output}/${fallback}`
  }
  setPath('planning', val('planning_artifacts', 'bmm', 'gds'), 'planning-artifacts')
  setPath('implementation', val('implementation_artifacts', 'bmm', 'gds'), 'implementation-artifacts')
  setPath('tests', val('test_artifacts', 'tea'), 'test-artifacts')
  const knowledge = resolvePath(val('project_knowledge', 'bmm'), root, vars)
  if (knowledge) paths.knowledge = knowledge

  // manifest (v6) or bmod.toml files (v7); the version number can't tell them apart
  const manifest = obj(await cached($, `${bmad}/_config/manifest.yaml`, undefined, parseYaml))
  const layout = !(await $.fs.exists(`${bmad}/_config/manifest.yaml`)) && (await $.fs.exists(`${bmad}/config.toml`)) ? 'v7' : 'v6'
  const v7 = layout === 'v7' ? await collectV7($, root) : undefined
  const inst = obj(manifest.installation)
  const modules: BmadModule[] = v7?.modules ?? arr(manifest.modules).map(m => {
    const o = obj(m)
    return {
      name: str(o.name) ?? '?',
      version: str(o.version),
      source: str(o.source),
      repoUrl: str(o.repoUrl),
      npmPackage: str(o.npmPackage),
      channel: str(o.channel),
      installDate: str(o.installDate),
      lastUpdated: str(o.lastUpdated),
    }
  })

  const agents: BmadAgent[] = Object.entries(obj(config.agents)).map(([code, a]) => {
    const o = obj(a)
    return { code, name: str(o.name), title: str(o.title), icon: str(o.icon), module: str(o.module), description: str(o.description) }
  })

  const help = (await cached($, `${bmad}/_config/bmad-help.csv`, undefined, parseCsv)) ?? []
  const skills: BmadSkill[] = v7?.skills ?? help.map(skillOf)

  // epic and story titles
  const titles = { epics: new Map<number, string>(), stories: new Map<string, string>() }
  for (const f of await walk($, paths.planning, 2, n => SKIP_DIRS.has(n))) {
    if (!/epic/i.test(f.rel) || !f.rel.endsWith('.md')) continue
    const t = await cached($, f.path, f.entry, parseEpicTitles)
    if (!t) continue
    for (const [k, v] of t.epics) if (!titles.epics.has(k)) titles.epics.set(k, v)
    for (const [k, v] of t.stories) if (!titles.stories.has(k)) titles.stories.set(k, v)
  }

  // implementation artifacts: story files, retros, build-auto results
  const impl = await list($, paths.implementation)
  const storyFiles = new Map<string, StoryFile & { file: string; mtimeMs: number }>()
  const retros = new Map<number, { verdict?: string; file: string }>()
  const buildAuto: BmadArtifact[] = []
  const byStatus: Record<string, number> = {}
  const other: BmadArtifact[] = []
  for (const e of impl) {
    if (e.kind !== 'file' || !e.name.endsWith('.md')) continue
    const path = `${paths.implementation}/${e.name}`
    if (e.name.startsWith('bmad-build-auto-result-')) {
      const doc = await cached($, path, e, frontmatter)
      if (!doc) continue
      const status = str(doc.fm.status) ?? /^Status:\s*(\S+)/m.exec(doc.body)?.[1] ?? 'unknown'
      byStatus[status] = (byStatus[status] ?? 0) + 1
      const a = artifactOf(e.name, 'build-auto', doc, e.mtimeMs)
      a.status = status
      const blocking = /^Blocking condition:\s*(.+)$/m.exec(doc.body)?.[1]
      if (blocking) a.extra = { ...a.extra, blocking }
      buildAuto.push(a)
      continue
    }
    const retro = /^epic-(\d+)-retro/.exec(e.name)
    if (retro) {
      const doc = await cached($, path, e, frontmatter)
      let verdict = str(doc?.fm.verdict)
      if (!verdict && doc) verdict = /\*\*Status:\*\*\s*(.+)$/m.exec(doc.body)?.[1].trim()
      retros.set(Number(retro[1]), { verdict, file: e.name })
      continue
    }
    const spec = SPEC_FILE.exec(e.name)
    if (spec || STORY_FILE.test(e.name)) {
      const format = spec ? 'spec' : 'legacy'
      const parsed = await cached($, path, e, t => parseStory(t, format), `story-${format}`)
      if (parsed) storyFiles.set(spec ? spec[1] : e.name.replace(/\.md$/, ''), { ...parsed, file: e.name, mtimeMs: e.mtimeMs })
      continue
    }
    if (e.name === 'deferred-work.md' || e.name === 'sprint-status.yaml') continue
    const doc = await cached($, path, e, frontmatter)
    if (doc) other.push(artifactOf(e.name, /context/.test(e.name) ? 'epic-context' : 'impl-doc', doc, e.mtimeMs))
  }
  buildAuto.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const fileFor = (key: string) => {
    const nums = storyNumbers(key)
    const direct = storyFiles.get(key)
    if (direct) return { slug: key, f: direct }
    if (!nums) return undefined
    for (const [slug, f] of storyFiles) {
      const n = storyNumbers(slug)
      if (n && n.epic === nums.epic && n.num === nums.num && !slug.startsWith('dw-')) return { slug, f }
    }
    return undefined
  }

  // sprint status
  let sprint: BmadSnapshot['sprint']
  const used = new Set<string>()
  const sprintCandidates = [`${paths.implementation}/sprint-status.yaml`, `${output}/sprint-status.yaml`, `${paths.implementation}/sprint-status.yml`]
  for (const file of sprintCandidates) {
    const y = await cached($, file, undefined, parseYaml)
    if (!y) continue
    const doc = obj(y)
    const dev = obj(doc.development_status)
    const epics = new Map<number, BmadEpic>()
    const epicOf = (n: number): BmadEpic => {
      let ep = epics.get(n)
      if (!ep) {
        ep = { num: n, title: titles.epics.get(n), status: 'backlog', stories: [] }
        epics.set(n, ep)
      }
      return ep
    }
    const counts: Record<string, number> = {}
    for (const [key, v] of Object.entries(dev)) {
      const raw = str(v) ?? 'backlog'
      const status = SPRINT_ALIASES[raw] ?? raw
      let m = /^epic-(\d+)-retrospective$/.exec(key)
      if (m) {
        epicOf(Number(m[1])).retro = status
        continue
      }
      m = /^epic-(\d+)$/.exec(key)
      if (m) {
        epicOf(Number(m[1])).status = status
        continue
      }
      const nums = storyNumbers(key)
      if (!nums) continue
      counts[status] = (counts[status] ?? 0) + 1
      const hit = fileFor(key)
      if (hit) used.add(hit.slug)
      const f = hit?.f
      epicOf(nums.epic).stories.push({
        key,
        epic: nums.epic,
        num: nums.num,
        title: titles.stories.get(`${nums.epic}-${nums.num}`) ?? f?.title ?? key.replace(/^\d+-\d+[a-z]?-/, '').replace(/-/g, ' '),
        status,
        file: f?.file,
        format: f?.format,
        fileStatus: f?.fileStatus,
        type: f?.type,
        route: f?.route,
        tasksDone: f?.tasksDone,
        tasksTotal: f?.tasksTotal,
        reviewOpen: f?.reviewOpen,
        reviewDone: f?.reviewDone,
        updatedMs: f?.mtimeMs,
      })
    }
    for (const [n, r] of retros) {
      const ep = epicOf(n)
      ep.retroVerdict = r.verdict
      ep.retroFile = r.file
    }
    const actionItems: BmadActionItem[] = arr(doc.action_items).map(a => {
      const o = obj(a)
      return { id: str(o.id), epic: str(o.epic), action: str(o.action) ?? '', owner: str(o.owner), status: str(o.status) ?? 'open', ref: str(o.ref) }
    })
    const lastUpdated = str(doc.last_updated)
    const when = parseSprintDate(lastUpdated ?? str(doc.generated))
    sprint = {
      file: file.slice(root.length + 1),
      generated: str(doc.generated),
      lastUpdated,
      stale: when !== undefined && Date.now() - when > 7 * 86400_000,
      counts,
      epics: [...epics.values()].sort((a, b) => a.num - b.num),
      actionItems,
    }
    break
  }
  if (!sprint && v7) sprint = await collectTickets($, root, output, str(core.active_initiative), errors)

  const storiesOutsideSprint: BmadStory[] = []
  for (const [slug, f] of storyFiles) {
    if (used.has(slug)) continue
    const nums = storyNumbers(slug)
    storiesOutsideSprint.push({
      key: slug,
      epic: nums?.epic ?? 0,
      num: nums?.num ?? '',
      title: f.title,
      status: f.status ?? 'unknown',
      file: f.file,
      format: f.format,
      fileStatus: f.fileStatus,
      type: f.type,
      route: f.route,
      tasksDone: f.tasksDone,
      tasksTotal: f.tasksTotal,
      reviewOpen: f.reviewOpen,
      reviewDone: f.reviewDone,
      updatedMs: f.mtimeMs,
    })
  }
  storiesOutsideSprint.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0))

  // deferred work
  const deferred = (await cached($, `${paths.implementation}/deferred-work.md`, undefined, parseDeferred)) ?? []

  // planning, specs, tests and the rest of the output folder
  const planning = await docArtifacts($, paths.planning, 3, planningKind, rel => !/(^|\/)reviews?\//.test(rel) || /review-/.test(rel))
  const changeProposals = planning.filter(a => a.kind === 'change-proposal')
  const specsDir = `${output}/specs`
  for (const a of await docArtifacts($, specsDir, 2, () => 'spec', rel => /SPEC\.md$|RETROSPECTIVE\.md$/.test(rel))) planning.push({ ...a, path: `specs/${a.path}` })
  const contextMd = await cached($, `${output}/project-context.md`, undefined, frontmatter)
  if (contextMd) planning.push(artifactOf('project-context.md', 'project-context', contextMd, 0))
  const agentsMd = await readText($, `${root}/AGENTS.md`)
  if (agentsMd && /bmad:context/.test(agentsMd)) planning.push({ path: 'AGENTS.md', kind: 'project-context', title: 'AGENTS.md (bmad:context)', mtimeMs: 0 })

  const quality = paths.tests.startsWith(paths.implementation) ? [] : await docArtifacts($, paths.tests, 3, qualityKind)
  const qSummary = await qualitySummary($, paths.tests, quality)
  // the full list stays, the per-file fields only for the newest ones
  const qualityLean = quality.map((a, i) => (i < 40 ? a : { ...a, extra: undefined }))
  const wfStatus = await workflowStatus($, output, paths.planning)
  const wds = await collectWds($, root, resolvePath(val('design_artifacts', 'wds'), root, vars))
  const automator = await collectAutomator($, root, output)
  const builder = await collectBuilder($, resolvePath(val('bmad_builder_output_folder', 'bmb'), root, vars))

  const known = new Set([paths.planning, paths.implementation, paths.tests, specsDir, `${output}/story-automator`].map(p => p.replace(/\/+$/, '')))
  const creative: BmadArtifact[] = []
  const inProgressSessions: BmadArtifact[] = []
  for (const e of await list($, output)) {
    const p = `${output}/${e.name}`
    if (e.kind === 'dir' && !known.has(p)) {
      for (const a of await docArtifacts($, p, 3, () => e.name)) creative.push({ ...a, path: `${e.name}/${a.path}` })
    } else if (e.kind === 'file' && /\.md$/.test(e.name) && e.name !== 'project-context.md') {
      const doc = await cached($, p, e, frontmatter)
      if (doc) creative.push(artifactOf(e.name, 'output', doc, e.mtimeMs))
    }
  }
  creative.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const f of await walk($, output, 4, n => SKIP_DIRS.has(n) || n === 'implementation-artifacts')) {
    if (!f.rel.endsWith('.memlog.md')) continue
    const doc = await cached($, f.path, f.entry, frontmatter)
    if (!doc || /complete|done|final/i.test(str(doc.fm.status) ?? '')) continue
    const a = artifactOf(f.rel.replace(/\/\.memlog\.md$/, ''), 'session', doc, f.entry.mtimeMs)
    a.title = str(doc.fm.topic) ?? str(doc.fm.goal) ?? a.path
    const lastLine = doc.body.trim().split('\n').filter(l => /^\s*-\s/.test(l)).pop()
    if (lastLine) a.extra = { ...a.extra, last: lastLine.replace(/^\s*-\s*/, '').slice(0, 160) }
    inProgressSessions.push(a)
  }
  inProgressSessions.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const loop = await collectLoop($, root, modules.some(m => m.name === 'bmad-loop'))
  const git = await collectGit($, root)

  return {
    at: Date.now(),
    ms: Date.now() - started,
    root,
    found: true,
    project: {
      name: str(core.project_name) ?? str(flat.project_name) ?? root.split('/').pop(),
      user: str(core.user_name) ?? str(flat.user_name),
      language: str(core.communication_language) ?? str(flat.communication_language),
      docLanguage: str(core.document_output_language) ?? str(flat.document_output_language),
      skillLevel: val('user_skill_level', 'bmm'),
      bmadVersion: v7 ? v7.version : str(inst.version),
      layout,
      installDate: str(inst.installDate),
      lastUpdated: str(inst.lastUpdated),
      ides: arr(manifest.ides).map(x => str(x) ?? '').filter(Boolean),
    },
    paths,
    modules,
    agents,
    skills,
    sprint,
    storiesOutsideSprint,
    planning,
    quality: qualityLean,
    qualitySummary: qSummary,
    workflowStatus: wfStatus,
    wds,
    orchestrations: automator.orchestrations,
    automatorActive: automator.active,
    builder,
    creative,
    other: other.sort((a, b) => b.mtimeMs - a.mtimeMs),
    inProgressSessions,
    deferred,
    buildAuto: { total: buildAuto.length, byStatus, latest: buildAuto.slice(0, 15) },
    changeProposals,
    loop,
    git,
    errors,
  }
}

export function emptySnapshot(root: string): BmadSnapshot {
  return {
    at: Date.now(),
    ms: 0,
    root,
    found: false,
    project: { ides: [] },
    paths: {},
    modules: [],
    agents: [],
    skills: [],
    storiesOutsideSprint: [],
    planning: [],
    quality: [],
    qualitySummary: { byKind: {}, gates: [], reviews: [] },
    workflowStatus: {},
    orchestrations: [],
    builder: [],
    creative: [],
    other: [],
    inProgressSessions: [],
    deferred: [],
    buildAuto: { total: 0, byStatus: {}, latest: [] },
    changeProposals: [],
    loop: { installed: false, runs: [] },
    errors: [],
  }
}

export { ago }

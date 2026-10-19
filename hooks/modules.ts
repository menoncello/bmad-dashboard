// Collectors for the external modules: TEA's gates and reviews, WDS's design
// log, the story automator's orchestrations, BMB's built skills, and the
// per-module workflow status files (GDS, WDS, older BMM).
import type { EngineInterface } from 'claude-code'

import type { BmadArtifact, BmadBuilderSkill, BmadDesignPage, BmadGate, BmadOrchestration, BmadQualitySummary, BmadWds } from '../types'
import { arr, frontmatter, obj, parseYaml, str } from './parse'
import type { Json, Obj } from './parse'

type $ = EngineInterface

async function readText($: $, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function list($: $, dir: string) {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

function json(text: string | undefined): Obj | undefined {
  if (!text) return undefined
  try {
    return obj(JSON.parse(text) as Json)
  } catch {
    return undefined
  }
}

const targetOf = (rel: string) =>
  rel
    .split('/')
    .pop()!
    .replace(/\.(md|json|ya?ml)$/, '')
    .replace(/^(gate-decision|traceability|test-review|nfr-assessment|atdd-checklist|automation-summary|test-design|trace-coverage-matrix)-?/, '') || 'project'

export async function qualitySummary($: $, testsDir: string, docs: BmadArtifact[]): Promise<BmadQualitySummary> {
  const byKind: Record<string, number> = {}
  for (const d of docs) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1

  const gates = new Map<string, BmadGate>()
  // the JSON gate files are the precise ones; frontmatter `gate` fills the rest
  const jsonFiles: string[] = []
  for (const e of await list($, testsDir)) if (e.kind === 'file' && /^(gate-decision|e2e-trace-summary).*\.json$/.test(e.name)) jsonFiles.push(e.name)
  for (const e of await list($, `${testsDir}/traceability`)) if (e.kind === 'file' && /\.json$/.test(e.name)) jsonFiles.push(`traceability/${e.name}`)
  for (const f of jsonFiles) {
    const j = json(await readText($, `${testsDir}/${f}`))
    if (!j) continue
    const target = obj(j.target)
    const id = str(target.id) ?? targetOf(f)
    const cov = obj(obj(j.coverage).inventory)
    const status = str(j.gate_status) ?? str(j.gate) ?? str(j.overall_status)
    if (!status) continue
    gates.set(id, {
      target: id,
      status,
      file: f,
      evaluatedAt: str(j.evaluated_at) ?? str(j.snapshot_at),
      criticalOpen: typeof j.critical_open === 'number' ? j.critical_open : undefined,
      coverage: cov.pct !== undefined ? `${str(cov.covered) ?? '?'}/${str(cov.total) ?? '?'} (${str(cov.pct)}%)` : undefined,
    })
  }
  for (const d of docs) {
    if (d.kind !== 'trace' && d.kind !== 'nfr' && d.kind !== 'gate') continue
    const status = d.extra?.gate ?? d.verdict
    if (!status) continue
    const id = `${targetOf(d.path)}${d.kind === 'nfr' ? ' (nfr)' : ''}`
    if (!gates.has(id)) gates.set(id, { target: id, status, file: d.path, evaluatedAt: d.updated })
  }

  const reviews: BmadQualitySummary['reviews'] = []
  for (const d of docs) {
    if (d.kind !== 'test-review' || !d.extra) continue
    const score = d.extra.qualityScore ? Number(d.extra.qualityScore) : undefined
    reviews.push({ target: targetOf(d.path), score, grade: d.extra.grade, recommendation: d.extra.recommendation, file: d.path })
  }

  let academy: BmadQualitySummary['academy']
  for (const e of await list($, `${testsDir}/teaching-progress`)) {
    if (!/\.ya?ml$/.test(e.name)) continue
    const y = obj(parseYaml((await readText($, `${testsDir}/teaching-progress/${e.name}`)) ?? ''))
    academy = {
      user: str(y.user),
      sessions: arr(y.sessions).map(s => {
        const o = obj(s)
        return { name: str(o.name) ?? str(o.id) ?? '?', status: str(o.status) ?? '?', score: typeof o.score === 'number' ? o.score : undefined }
      }),
    }
  }

  return {
    byKind,
    gates: [...gates.values()].sort((a, b) => (b.evaluatedAt ?? '').localeCompare(a.evaluatedAt ?? '')),
    reviews,
    academy,
  }
}

// TEA test reviews keep their score in the body, not the frontmatter.
export function reviewScore(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  // "**Quality Score**: 88/100 (B)" in the template, "**Quality score: 88/100 (B, approve with comments)**" in the wild
  const s = /quality score\**\s*:?\s*\**\s*(\d+)\s*\/\s*100\s*(?:\(\s*([A-F][+-]?)\s*(?:[,;]\s*([^)]*))?\))?/i.exec(body)
  if (s) {
    out.qualityScore = s[1]
    if (s[2]) out.grade = s[2]
    if (s[3]) out.recommendation = s[3].trim()
  }
  const r = /\*\*Recommendation\*\*\s*:?\s*\**\s*(Approve with Comments|Approve|Request Changes|Block)/i.exec(body) ?? /^## Recommendation\s*\n+\s*\**\s*(Approve with Comments|Approve|Request Changes|Block)/im.exec(body)
  if (r) out.recommendation = r[1]
  return out
}

export async function workflowStatus($: $, output: string, planning: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  for (const dir of [output, planning]) {
    for (const e of await list($, dir)) {
      if (e.kind !== 'file' || !/workflow-status\.ya?ml$/.test(e.name)) continue
      const y = obj(parseYaml((await readText($, `${dir}/${e.name}`)) ?? ''))
      const flat: Record<string, string> = {}
      const visit = (o: Obj, prefix: string) => {
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, `${prefix}${k}.`)
          else if (!Array.isArray(v) && v !== null) flat[`${prefix}${k}`] = String(v)
        }
      }
      visit(y, '')
      out[e.name.replace(/\.ya?ml$/, '')] = flat
    }
  }
  return out
}

function tableRows(section: string): string[][] {
  return section
    .split('\n')
    .filter(l => /^\s*\|/.test(l) && !/^\s*\|\s*:?-{2,}/.test(l))
    .map(l =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(c => c.trim()),
    )
}

export async function collectWds($: $, root: string, designDir: string | undefined): Promise<BmadWds | undefined> {
  const candidates = [designDir, `${root}/design-artifacts`, `${root}/design-process`].filter(Boolean) as string[]
  for (const dir of candidates) {
    const log = await readText($, `${dir}/_progress/00-design-log.md`)
    const outline = await readText($, `${dir}/_progress/wds-project-outline.yaml`)
    if (!log && !outline) continue
    const wds: BmadWds = { root: dir.slice(root.length + 1) || dir, current: [], backlogOpen: 0, backlogDone: 0, pages: [], deliveries: [], phases: [] }
    if (log) {
      for (const line of log.split('\n')) {
        if (/^\s*[-*] \[ \]/.test(line)) wds.backlogOpen++
        else if (/^\s*[-*] \[[xX]\]/.test(line)) wds.backlogDone++
      }
      const sections = log.split(/^##+\s+/m)
      for (const s of sections) {
        const title = s.split('\n')[0].toLowerCase()
        const rows = tableRows(s)
        if (rows.length < 2) continue
        const head = rows[0].map(h => h.toLowerCase())
        if (title.startsWith('current')) {
          for (const r of rows.slice(1)) if (r.some(Boolean)) wds.current.push(r.filter(Boolean).join(' · '))
        } else if (title.includes('design loop')) {
          const col = (name: string) => head.findIndex(h => h.includes(name))
          const latest = new Map<string, BmadDesignPage>()
          for (const r of rows.slice(1)) {
            const page = r[col('page')] ?? ''
            if (!page) continue
            latest.set(page, { scenario: r[col('scenario')], step: r[col('step')], page, status: r[col('status')] ?? '?', updated: r[col('updated')] })
          }
          wds.pages = [...latest.values()]
        }
      }
    }
    if (outline) {
      const y = obj(parseYaml(outline))
      for (const [name, p] of Object.entries(obj(y.phases))) wds.phases.push({ name, status: str(obj(p).status) ?? '?' })
    }
    for (const sub of ['deliveries', 'E-Development/deliveries']) {
      for (const e of await list($, `${dir}/${sub}`)) {
        if (!/\.ya?ml$/.test(e.name)) continue
        const d = obj(obj(parseYaml((await readText($, `${dir}/${sub}/${e.name}`)) ?? '')).delivery)
        wds.deliveries.push({ id: str(d.id) ?? e.name, name: str(d.name), status: str(d.status), priority: str(d.priority) })
      }
    }
    return wds
  }
  return undefined
}

export async function collectAutomator($: $, root: string, output: string): Promise<{ orchestrations: BmadOrchestration[]; active?: Record<string, string> }> {
  const orchestrations: BmadOrchestration[] = []
  const dir = `${output}/story-automator`
  const files = (await list($, dir)).filter(e => e.kind === 'file' && /^orchestration-.*\.md$/.test(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const e of files.slice(0, 5)) {
    const { fm } = frontmatter((await readText($, `${dir}/${e.name}`)) ?? '')
    orchestrations.push({
      file: e.name,
      epic: str(fm.epic),
      name: str(fm.epicName),
      status: str(fm.status),
      currentStory: str(fm.currentStory),
      currentStep: str(fm.currentStep),
      lastUpdated: str(fm.lastUpdated),
      active: arr(fm.activeSessions).length,
      completed: arr(fm.completedSessions).length,
    })
  }
  let active: Record<string, string> | undefined
  for (const d of ['.claude', '.agents', '.codex']) {
    const j = json(await readText($, `${root}/${d}/.story-automator-active`))
    if (!j) continue
    active = {}
    for (const [k, v] of Object.entries(j)) if (typeof v !== 'object' || v === null) active[k] = String(v)
    break
  }
  return { orchestrations, active }
}

export async function collectBuilder($: $, skillsDir: string | undefined): Promise<BmadBuilderSkill[]> {
  if (!skillsDir) return []
  const out: BmadBuilderSkill[] = []
  for (const e of await list($, skillsDir)) {
    if (e.kind !== 'dir' || e.name === 'reports') continue
    const base = `${skillsDir}/${e.name}`
    if (!(await $.fs.exists(`${base}/SKILL.md`))) continue
    const memlog = await readText($, `${base}/.memlog.md`)
    const inProgress = memlog !== undefined && !/status:\s*(complete|done|final)/i.test(frontmatter(memlog).fm.status ? `status: ${str(frontmatter(memlog).fm.status)}` : '')
    const runs = (await list($, `${base}/.analysis`)).filter(r => r.kind === 'dir').map(r => r.name).sort()
    const last = runs.pop()
    const findings = last ? json(await readText($, `${base}/.analysis/${last}/findings.json`)) : undefined
    out.push({ name: e.name, verdict: str(findings?.verdict), grade: str(findings?.grade), analyzedAt: last, inProgress })
  }
  return out
}

// Small parsers for the formats BMAD writes: YAML (sprint-status, frontmatter,
// manifests), TOML (config.toml, policy.toml), CSV and markdown frontmatter.
// They cover the shapes BMAD produces, not the full specs.

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
export type Obj = { [k: string]: Json }

function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function splitFlow(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') cur += body[++i] ?? ''
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function yamlScalar(raw: string): Json {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(yamlScalar)
  if (s.startsWith('{') && s.endsWith('}')) {
    const o: Obj = {}
    for (const part of splitFlow(s.slice(1, -1))) {
      const at = part.indexOf(':')
      if (at > 0) o[unquote(part.slice(0, at).trim())] = yamlScalar(part.slice(at + 1))
    }
    return o
  }
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s)
  return s
}

function unquote(k: string): string {
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1)
  return k
}

type Line = { indent: number; text: string }

function keyAt(text: string): number {
  // the colon that ends a mapping key: followed by space or end of line, outside quotes
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if ((c === '"' || c === "'") && i === 0) quote = c
    else if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return i
  }
  return -1
}

export function parseYaml(src: string): Json {
  const lines: Line[] = []
  for (const rawLine of src.replace(/\r/g, '').split('\n')) {
    if (/^\s*#/.test(rawLine) || /^(---|\.\.\.)\s*$/.test(rawLine)) continue
    const text = stripComment(rawLine).replace(/\s+$/, '')
    if (!text.trim()) continue
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim() })
  }
  let i = 0

  function block(indent: number): Json {
    if (i >= lines.length) return null
    return lines[i].text.startsWith('- ') || lines[i].text === '-' ? list(lines[i].indent) : map(indent)
  }

  function blockScalar(parentIndent: number, folded: boolean): string {
    const parts: string[] = []
    while (i < lines.length && lines[i].indent > parentIndent) parts.push(lines[i++].text)
    return parts.join(folded ? ' ' : '\n')
  }

  function value(rest: string, indent: number): Json {
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') return blockScalar(indent, rest.startsWith('>'))
    if (rest !== '') return yamlScalar(rest)
    if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith('- '))))
      return block(lines[i].indent)
    return null
  }

  function map(indent: number): Obj {
    const o: Obj = {}
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const { text } = lines[i]
      const at = keyAt(text)
      i++
      if (at < 0) continue
      o[unquote(text.slice(0, at).trim())] = value(text.slice(at + 1).trim(), indent)
    }
    return o
  }

  function list(indent: number): Json[] {
    const out: Json[] = []
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const rest = lines[i].text.slice(1).trim()
      i++
      if (rest === '') {
        out.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null)
        continue
      }
      const at = keyAt(rest)
      if (at > 0 && !rest.startsWith('"') && !rest.startsWith('{') && !rest.startsWith('[')) {
        // a map item: its first key sits on the dash line, the rest indented below
        const itemIndent = indent + 2
        const o: Obj = {}
        o[unquote(rest.slice(0, at).trim())] = value(rest.slice(at + 1).trim(), itemIndent)
        if (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith('- ')) Object.assign(o, map(lines[i].indent))
        out.push(o)
      } else out.push(yamlScalar(rest))
    }
    return out
  }

  return lines.length ? block(lines[0].indent) : null
}

export type Doc = { fm: Obj; body: string }

export function frontmatter(src: string): Doc {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(src)
  if (!m) return { fm: {}, body: src }
  let fm: Json = null
  try {
    fm = parseYaml(m[1])
  } catch {
    fm = null
  }
  return { fm: fm && typeof fm === 'object' && !Array.isArray(fm) ? fm : {}, body: src.slice(m[0].length) }
}

function tomlValue(s: string): Json {
  s = s.trim()
  if (s.startsWith('"""')) return s.slice(3, s.lastIndexOf('"""'))
  if (s.startsWith("'''")) return s.slice(3, s.lastIndexOf("'''"))
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'")) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('[')) return splitFlow(s.slice(1, s.lastIndexOf(']'))).filter(Boolean).map(tomlValue)
  if (s.startsWith('{')) {
    const o: Obj = {}
    for (const part of splitFlow(s.slice(1, s.lastIndexOf('}')))) {
      const at = part.indexOf('=')
      if (at > 0) o[unquote(part.slice(0, at).trim())] = tomlValue(part.slice(at + 1))
    }
    return o
  }
  const n = Number(s.replace(/_/g, ''))
  return Number.isFinite(n) && s !== '' ? n : s
}

function tomlKeyPath(k: string): string[] {
  return splitDotted(k).map(p => unquote(p.trim()))
}

function splitDotted(k: string): string[] {
  const out: string[] = []
  let quote = ''
  let cur = ''
  for (const c of k) {
    if (quote) {
      if (c === quote) quote = ''
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '.') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function bracketBalance(s: string): number {
  let depth = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return depth
}

export function parseToml(src: string): Obj {
  const root: Obj = {}
  let table: Obj = root
  const lines = src.replace(/\r/g, '').split('\n')
  const descend = (path: string[], fromRoot: Obj): Obj => {
    let t = fromRoot
    for (const p of path) {
      let next = t[p]
      if (Array.isArray(next)) next = next[next.length - 1]
      if (!next || typeof next !== 'object') {
        next = {}
        t[p] = next
      }
      t = next as Obj
    }
    return t
  }
  for (let n = 0; n < lines.length; n++) {
    let line = stripComment(lines[n]).trim()
    if (!line) continue
    const arr = /^\[\[(.+)\]\]$/.exec(line)
    if (arr) {
      const path = tomlKeyPath(arr[1])
      const parent = descend(path.slice(0, -1), root)
      const last = path[path.length - 1]
      const list = Array.isArray(parent[last]) ? (parent[last] as Json[]) : []
      const item: Obj = {}
      list.push(item)
      parent[last] = list
      table = item
      continue
    }
    const tab = /^\[(.+)\]$/.exec(line)
    if (tab) {
      table = descend(tomlKeyPath(tab[1]), root)
      continue
    }
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    let raw = line.slice(at + 1).trim()
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      const fence = raw.slice(0, 3)
      while (raw.indexOf(fence, 3) < 0 && n + 1 < lines.length) raw += '\n' + lines[++n]
    } else {
      while (bracketBalance(raw) > 0 && n + 1 < lines.length) raw += ' ' + stripComment(lines[++n]).trim()
    }
    const path = tomlKeyPath(key)
    descend(path.slice(0, -1), table)[path[path.length - 1]] = tomlValue(raw)
  }
  return root
}

export function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    out[k] =
      prev && v && typeof prev === 'object' && typeof v === 'object' && !Array.isArray(prev) && !Array.isArray(v)
        ? deepMerge(prev as Obj, v as Obj)
        : v
  }
  return out
}

export function parseCsv(src: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      if (row.some(x => x !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  if (row.some(x => x !== '')) rows.push(row)
  const [head, ...rest] = rows
  if (!head) return []
  return rest.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

export function str(v: Json | undefined): string | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

export function obj(v: Json | undefined): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export function arr(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : []
}

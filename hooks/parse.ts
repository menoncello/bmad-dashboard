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
  // only when the number round-trips: `6.10` and `1.0` stay strings
  if (/^-?\d+(\.\d+)?$/.test(s) && String(Number(s)) === s) return Number(s)
  return s
}

function unquote(k: string): string {
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1)
  return k
}

// Raw lines are kept (blank and comment lines flagged as `skip`) so block scalars
// can read them verbatim; `text` is the comment-stripped, trimmed line.
type Line = { indent: number; text: string; raw: string; skip: boolean }

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

// `|` or `>` plus an optional chomping indicator (+/-) and indentation digit, in either order
const BLOCK_HEADER = /^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/

export function parseYaml(src: string): Json {
  const lines: Line[] = src
    .replace(/\r/g, '')
    .split('\n')
    .map(raw => {
      const skip = !raw.trim() || /^\s*#/.test(raw) || /^(---|\.\.\.)\s*$/.test(raw)
      return {
        indent: raw.length - raw.trimStart().length,
        text: skip ? '' : stripComment(raw).trim(),
        raw,
        skip,
      }
    })
  let i = 0

  function skipBlank() {
    while (i < lines.length && lines[i].skip) i++
  }

  function isItem(text: string): boolean {
    return text.startsWith('- ') || text === '-'
  }

  function block(indent: number): Json {
    skipBlank()
    if (i >= lines.length) return null
    return isItem(lines[i].text) ? list(lines[i].indent) : map(indent)
  }

  // Joins the following lines onto a flow collection until its brackets balance.
  function joinFlow(rest: string): string {
    while (bracketBalance(rest) > 0 && i < lines.length) {
      const l = lines[i++]
      if (!l.skip) rest += ' ' + l.text
    }
    return rest
  }

  function blockScalar(parentIndent: number, header: string): string {
    const folded = header[0] === '>'
    const keep = header.includes('+')
    const digit = /[1-9]/.exec(header)
    let width = digit ? parentIndent + Number(digit[0]) : -1
    const body: string[] = []
    while (i < lines.length) {
      const l = lines[i]
      if (!l.raw.trim()) {
        body.push('')
        i++
        continue
      }
      if (l.indent <= parentIndent || (width >= 0 && l.indent < width)) break
      if (width < 0) width = l.indent
      body.push(l.raw.slice(width))
      i++
    }
    let end = body.length
    while (end > 0 && body[end - 1] === '') end--
    const content = body.slice(0, end)
    let text = ''
    if (!folded) text = content.join('\n')
    else {
      let blanks = 0
      let prev: string | undefined
      for (const l of content) {
        if (l === '') {
          blanks++
          continue
        }
        if (prev === undefined) text = '\n'.repeat(blanks) + l
        else {
          const more = /^\s/.test(l) || /^\s/.test(prev)
          text += (more ? '\n'.repeat(blanks + 1) : blanks ? '\n'.repeat(blanks) : ' ') + l
        }
        prev = l
        blanks = 0
      }
    }
    return keep && content.length ? text + '\n'.repeat(1 + body.length - end) : text
  }

  function value(rest: string, indent: number): Json {
    if (BLOCK_HEADER.test(rest)) return blockScalar(indent, rest)
    if (rest !== '') return yamlScalar(rest.startsWith('[') || rest.startsWith('{') ? joinFlow(rest) : rest)
    skipBlank()
    if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i].text)))) {
      const t = lines[i].text
      if (t.startsWith('[') || t.startsWith('{')) {
        i++
        return yamlScalar(joinFlow(t))
      }
      return block(lines[i].indent)
    }
    return null
  }

  function map(indent: number): Obj {
    const o: Obj = {}
    for (skipBlank(); i < lines.length && lines[i].indent === indent && !isItem(lines[i].text); skipBlank()) {
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
    for (skipBlank(); i < lines.length && lines[i].indent === indent && isItem(lines[i].text); skipBlank()) {
      let rest = lines[i].text.slice(1).trim()
      i++
      if (rest === '') {
        skipBlank()
        out.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null)
        continue
      }
      if (BLOCK_HEADER.test(rest)) {
        out.push(blockScalar(indent, rest))
        continue
      }
      if (rest.startsWith('[') || rest.startsWith('{')) rest = joinFlow(rest)
      const at = keyAt(rest)
      if (at > 0 && !rest.startsWith('"') && !rest.startsWith('{') && !rest.startsWith('[')) {
        // a map item: its first key sits on the dash line, the rest indented below
        const itemIndent = indent + 2
        const o: Obj = {}
        o[unquote(rest.slice(0, at).trim())] = value(rest.slice(at + 1).trim(), itemIndent)
        skipBlank()
        if (i < lines.length && lines[i].indent > indent && !isItem(lines[i].text)) Object.assign(o, map(lines[i].indent))
        out.push(o)
      } else out.push(yamlScalar(rest))
    }
    return out
  }

  skipBlank()
  return i < lines.length ? block(lines[i].indent) : null
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

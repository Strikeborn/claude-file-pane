/**
 * Documents and the Project view.
 * - A Markdown file reads as a document: sections fold by heading, `- [ ]` / `- [x]` items are buttons that flip the
 *   box in the file (the pane's own save path: backup first, refused if the line changed).
 * - Project (the session's folder): Timeline (git commits + the changelog's versions), Items (every checkbox in the
 *   project's Markdown, by file and heading), Features (the changelog's newest version), Building blocks (a doc's
 *   "Building blocks" section, else DEVELOPING's sections). All read from the project's own files, cached by time.
 */

export type Section = { key: string; level: number; title: string; from: number; to: number }
export type Task = { line: number; done: boolean; text: string; raw: string; heading: string }

const TASK = /^(\s*[-*+]\s+)\[( |x|X)\](\s+.*)?$/

export function sections(lines: string[]): Section[] {
  const out: Section[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    const m = !fence && /^(#{1,3})\s+(.*)$/.exec(l)
    if (m) out.push({ key: `${i}:${m[2]}`, level: m[1]!.length, title: m[2]!.trim(), from: i, to: lines.length })
  })
  for (let i = 0; i < out.length; i++) {
    const next = out.slice(i + 1).find(s => s.level <= out[i]!.level)
    out[i]!.to = next ? next.from : lines.length
  }
  return out
}

export function tasks(lines: string[]): Task[] {
  const out: Task[] = []
  let heading = ''
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    if (fence) return
    const h = /^#{1,6}\s+(.*)$/.exec(l)
    if (h) heading = h[1]!.trim()
    const m = TASK.exec(l)
    if (m) out.push({ line: i, done: m[2] !== ' ', text: (m[3] ?? '').trim(), raw: l, heading })
  })
  return out
}

export const flipTask = (raw: string) => raw.replace(/\[( |x|X)\]/, (_a, c: string) => (c === ' ' ? '[x]' : '[ ]'))

/** The headings above line `at`, outermost first (`## Plan` › `### Week 1`), code fences skipped. */
export function headingPath(lines: string[], at: number): string[] {
  const stack: { level: number; title: string }[] = []
  let fence = false
  for (let i = 0; i < at && i < lines.length; i++) {
    const l = lines[i]!
    if (/^\s*```/.test(l)) fence = !fence
    const h = !fence && /^(#{1,6})\s+(.*)$/.exec(l)
    if (!h) continue
    while (stack.length && stack[stack.length - 1]!.level >= h[1]!.length) stack.pop()
    stack.push({ level: h[1]!.length, title: h[2]!.trim() })
  }
  return stack.map(s => s.title)
}

/** Several boxes on one line (`- [ ] a - [ ] b`): only the first is a real checkbox, the rest are text. */
export const boxesIn = (raw: string) => (raw.match(/\[( |x|X)\]/g) ?? []).length

/** That line as one item per box, each keeping its own tick: `- [ ] a - [x] b` → `- [ ] a`, `- [x] b`. */
export function splitBoxes(raw: string): string[] {
  const indent = /^(\s*)/.exec(raw)?.[1] ?? ''
  const marker = /^\s*([-*+])\s+/.exec(raw)?.[1] ?? '-'
  const out: string[] = []
  const re = /\[( |x|X)\]/g
  const hits = [...raw.matchAll(re)]
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : raw.length
    // the text up to the next box, without a list marker or separator left before it
    const text = raw.slice(m.index! + m[0].length, end).replace(/\s*(?:[-*+•|,;]\s*)?$/, '').trim()
    out.push(`${indent}${marker} [${m[1] === ' ' ? ' ' : 'x'}] ${text}`.trimEnd())
  })
  return out
}

/** A unified diff as rows of two columns: removed lines on the left, added on the right, context on both. */
export type SideRow = { left?: string; right?: string; kind: 'same' | 'change' | 'hunk' | 'meta' }
export function sideBySide(diff: string): SideRow[] {
  const rows: SideRow[] = []
  let dels: string[] = []
  let adds: string[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i], kind: 'change' })
    dels = []
    adds = []
  }
  let inHunk = false
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith('@@')) {
      flush()
      inHunk = true
      rows.push({ left: l, kind: 'hunk' })
    } else if (!inHunk) {
      if (/^(diff --git|new file|deleted file|Binary files)/.test(l)) rows.push({ left: l, kind: 'meta' })
    } else if (l.startsWith('-')) dels.push(l.slice(1))
    else if (l.startsWith('+')) adds.push(l.slice(1))
    else if (l.startsWith(' ') || l === '') {
      flush()
      rows.push({ left: l.slice(1), right: l.slice(1), kind: 'same' })
    } else if (l.startsWith('diff --git')) {
      flush()
      inHunk = false
      rows.push({ left: l, kind: 'meta' })
    }
  }
  flush()
  return rows
}

/** Sections that say what's next: a heading about next steps, open issues or to-dos. */
export const NEXT_HEADING = /\b(next|open issues|to ?do|todo|roadmap|backlog|plans?)\b/i

// ---------- parsing the project's files (text in, results out; reading is register.tsx's: $ stays in that file) ----------

export type TimelineEntry = { date: string; kind: 'commit' | 'release'; text: string; detail?: string; line?: number; raw?: string }
/** A section of a doc: its title, its text, and its lines (heading at `from`, body to `to`) as written. */
export type Block = { title: string; body: string; from: number; raw: string[] }

/** git log lines "date<TAB>hash<TAB>subject". */
export function commitsFrom(out: string): TimelineEntry[] {
  const list: TimelineEntry[] = []
  for (const l of out.split(/\r?\n/)) {
    const [date, hash, ...subject] = l.split('\t')
    if (date && subject.length) list.push({ date, kind: 'commit', text: subject.join('\t'), detail: hash })
  }
  return list
}

/** CHANGELOG.md "## v1.2 (2026-10-26, …)" headings. */
export function releasesFrom(text: string): TimelineEntry[] {
  const found: TimelineEntry[] = []
  text.split(/\r?\n/).forEach((l, line) => {
    const m = /^##\s+(.+?)\s*(?:\((\d{4}-\d{2}-\d{2})[^)]*\))?\s*$/.exec(l)
    if (m) found.push({ date: m[2] ?? '', kind: 'release', text: m[1]!, detail: l.replace(/^##\s+/, ''), line, raw: l })
  })
  return found
}

/** The newest version's ### sections of a changelog. */
export function featuresFrom(text: string): { version: string; blocks: Block[] } {
  const lines = text.split(/\r?\n/)
  const s = sections(lines)
  const top = s.find(x => x.level === 2)
  if (!top) return { version: '', blocks: [] }
  return {
    version: top.title,
    blocks: s
      .filter(x => x.level === 3 && x.from > top.from && x.from < top.to)
      .map(x => ({ title: x.title, body: lines.slice(x.from + 1, x.to).join('\n').trim(), from: x.from, raw: lines.slice(x.from + 1, x.to) })),
  }
}

/** A "Building blocks" heading's sub-sections; `orTop`: else the document's ## sections. */
export function blocksFrom(text: string, orTop: boolean): Block[] {
  const lines = text.split(/\r?\n/)
  const s = sections(lines)
  const bb = s.find(x => /building blocks/i.test(x.title))
  const parts = bb ? s.filter(x => x.level === bb.level + 1 && x.from > bb.from && x.from < bb.to) : orTop ? s.filter(x => x.level === 2) : []
  return parts.map(x => ({ title: x.title, body: lines.slice(x.from + 1, x.to).join('\n').trim(), from: x.from, raw: lines.slice(x.from + 1, x.to) }))
}

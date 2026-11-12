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
    const head = /^#{1,6}\s+(.*)$/.exec(l)
    if (head) heading = head[1]!.trim()
    const m = TASK.exec(l)
    if (m) out.push({ line: i, done: m[2] !== ' ', text: (m[3] ?? '').trim(), raw: l, heading })
  })
  return out
}

export const flipTask = (raw: string) => raw.replace(/\[( |x|X)\]/, (_a, c: string) => (c === ' ' ? '[x]' : '[ ]'))

/** The date the pane writes after a ticked item when asked to: `- [x] paint (done 2026-11-03 14:50)`. */
export const DONE_DATE = /\s+\(done \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\s*$/
/** A flipped line with its done date: added when ticked and `stamp` is given, taken off when unticked. */
export const markDone = (raw: string, ticked: boolean, stamp?: string) => {
  const bare = raw.replace(DONE_DATE, '')
  return !ticked ? bare : stamp ? `${bare} (done ${stamp})` : raw
}

/** The headings above line `at`, outermost first (`## Plan` › `### Week 1`), code fences skipped. */
export function headingPath(lines: string[], at: number): string[] {
  const stack: { level: number; title: string }[] = []
  let fence = false
  for (let i = 0; i < at && i < lines.length; i++) {
    const l = lines[i]!
    if (/^\s*```/.test(l)) fence = !fence
    const head = !fence && /^(#{1,6})\s+(.*)$/.exec(l)
    if (!head) continue
    while (stack.length && stack[stack.length - 1]!.level >= head[1]!.length) stack.pop()
    stack.push({ level: head[1]!.length, title: head[2]!.trim() })
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

/** A unified diff's lines in one column, each with its line number in the old and the new file (from the hunks). */
export type NumberedLine = { text: string; kind: 'add' | 'del' | 'same' | 'hunk' | 'meta'; oldNo?: number; newNo?: number }
export function numberedDiff(diff: string): NumberedLine[] {
  const out: NumberedLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (m) {
      inHunk = true
      oldNo = Number(m[1])
      newNo = Number(m[2])
      out.push({ text: l, kind: 'hunk' })
    } else if (!inHunk || l.startsWith('diff --git')) {
      inHunk = false
      if (l && !/^(index |--- |\+\+\+ )/.test(l)) out.push({ text: l, kind: 'meta' })
    } else if (l.startsWith('-')) out.push({ text: l, kind: 'del', oldNo: oldNo++ })
    else if (l.startsWith('+')) out.push({ text: l, kind: 'add', newNo: newNo++ })
    else if (l.startsWith(' ')) out.push({ text: l, kind: 'same', oldNo: oldNo++, newNo: newNo++ })
  }
  return out
}

/**
 * A unified diff as rows of two columns: removed lines on the left, added on the right, context on both, each with
 * its line number in the old (`leftNo`) and new (`rightNo`) file, counted from the hunk headers.
 */
export type SideRow = { left?: string; right?: string; kind: 'same' | 'change' | 'hunk' | 'meta'; leftNo?: number; rightNo?: number }
export function sideBySide(diff: string): SideRow[] {
  const rows: SideRow[] = []
  let dels: string[] = []
  let adds: string[] = []
  let oldNo = 0
  let newNo = 0
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++)
      rows.push({ left: dels[i], right: adds[i], kind: 'change', ...(i < dels.length ? { leftNo: oldNo++ } : {}), ...(i < adds.length ? { rightNo: newNo++ } : {}) })
    dels = []
    adds = []
  }
  let inHunk = false
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith('@@')) {
      flush()
      inHunk = true
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      rows.push({ left: l, kind: 'hunk' })
    } else if (!inHunk) {
      if (/^(diff --git|new file|deleted file|Binary files)/.test(l)) rows.push({ left: l, kind: 'meta' })
    } else if (l.startsWith('-')) dels.push(l.slice(1))
    else if (l.startsWith('+')) adds.push(l.slice(1))
    else if (l.startsWith(' ') || l === '') {
      flush()
      rows.push({ left: l.slice(1), right: l.slice(1), kind: 'same', leftNo: oldNo++, rightNo: newNo++ })
    } else if (l.startsWith('diff --git')) {
      flush()
      inHunk = false
      rows.push({ left: l, kind: 'meta' })
    }
  }
  flush()
  return rows
}

/**
 * Word-level changes between a line and what replaced it: each side as parts, `changed` where the words differ
 * (an LCS over words, spaces and punctuation). Long lines (over 300 tokens a side) come back whole, as changed.
 */
export type WordPart = { text: string; changed: boolean }
export function wordDiff(before: string, after: string): { left: WordPart[]; right: WordPart[] } {
  const tok = (s: string) => s.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []
  const a = tok(before)
  const b = tok(after)
  if (a.length > 300 || b.length > 300) return { left: [{ text: before, changed: true }], right: [{ text: after, changed: true }] }
  // lcs[i][j]: the common run of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const left: WordPart[] = []
  const right: WordPart[] = []
  const push = (side: WordPart[], text: string, changed: boolean) => {
    const last = side[side.length - 1]
    if (last && last.changed === changed) last.text += text
    else side.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(left, a[i]!, false)
      push(right, b[j]!, false)
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) push(right, b[j++]!, true)
    else push(left, a[i++]!, true)
  }
  return { left, right }
}

/** Sections that say what's next: a heading about next steps, open issues or to-dos. */
export const NEXT_HEADING = /\b(next|open issues|to ?do|todo|roadmap|backlog|plans?)\b/i

// ---------- parsing the project's files (text in, results out; reading is register.tsx's: $ stays in that file) ----------

export type TimelineEntry = {
  date: string
  kind: 'commit' | 'release'
  text: string
  detail?: string
  line?: number
  raw?: string
  /** a version's explanation: its ### sections, else the bold leads of its points ("Moonlight lists your games; Sidebar") */
  summary?: string
  /** a version's top-level points (sub-points left out), markdown marks removed */
  points?: string[]
}
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

const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')

/** A version's one-line explanation: its ### sections, else each point's bold lead (or its start), the first few. */
export function versionSummary(points: string[], heads: string[]): string {
  const parts = heads.length
    ? heads
    : points.map(p => (/^\*\*(.+?)\*\*/.exec(p)?.[1] ?? plain(p).split(/[.:;]/)[0]!).replace(/[:.\s]+$/, '').trim()).filter(Boolean)
  const shown = parts.slice(0, 4)
  return shown.join('; ') + (parts.length > shown.length ? `; +${parts.length - shown.length} more` : '')
}

/** CHANGELOG.md "## v1.2 (2026-10-26, …)" headings, each with what it changed (its points and a summary). */
export function releasesFrom(text: string): TimelineEntry[] {
  const found: TimelineEntry[] = []
  let cur: { e: TimelineEntry; points: string[]; heads: string[] } | undefined
  let inPoint = false
  const close = () => {
    if (!cur) return
    cur.e.points = cur.points.map(plain)
    const summary = versionSummary(cur.points, cur.heads)
    if (summary) cur.e.summary = summary
  }
  text.split(/\r?\n/).forEach((l, line) => {
    const m = /^##\s+(.+?)\s*(?:\((\d{4}-\d{2}-\d{2})[^)]*\))?\s*$/.exec(l)
    if (m) {
      close()
      const e: TimelineEntry = { date: m[2] ?? '', kind: 'release', text: m[1]!, detail: l.replace(/^##\s+/, ''), line, raw: l }
      found.push(e)
      cur = { e, points: [], heads: [] }
      inPoint = false
      return
    }
    if (!cur) return
    const head = /^###\s+(.+)/.exec(l)
    if (head) {
      cur.heads.push(plain(head[1]!.trim()))
      inPoint = false
    } else if (/^- \S/.test(l)) {
      cur.points.push(l.slice(2).trim())
      inPoint = true
    } else if (inPoint && /^ {2}(?! *-)\S/.test(l)) cur.points[cur.points.length - 1] += ` ${l.trim()}`
    else if (!/^\s/.test(l)) inPoint = false
  })
  close()
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

/** How long ago, in a word or two: "just now", "12 min", "3 h", "2 days", "5 weeks", "4 months", "2 years". */
export function age(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000)
  const n = (x: number, one: string) => `${Math.floor(x)} ${one}${Math.floor(x) === 1 ? '' : 's'}`
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86_400) return `${Math.floor(s / 3600)} h`
  if (s < 14 * 86_400) return n(s / 86_400, 'day')
  if (s < 60 * 86_400) return n(s / (7 * 86_400), 'week')
  if (s < 365 * 86_400) return n(s / (30 * 86_400), 'month')
  return n(s / (365 * 86_400), 'year')
}

/** New (a day), recent (a week) or old: the colour a date is drawn in. */
export function ageTone(ms: number, now: number): 'new' | 'recent' | 'old' {
  const d = (now - ms) / 86_400_000
  return d < 1 ? 'new' : d < 7 ? 'recent' : 'old'
}

export type Commit = { sha: string; at: number; author: string; subject: string }

/** `git log --format=%H%x09%ct%x09%an%x09%s`: one commit a line. */
export function logFrom(out: string): Commit[] {
  return out
    .split(/\r?\n/)
    .map(l => l.split('\t'))
    .filter(p => p.length >= 4 && /^[0-9a-f]{7,40}$/.test(p[0]!))
    .map(p => ({ sha: p[0]!, at: Number(p[1]) * 1000, author: p[2]!, subject: p.slice(3).join('\t') }))
}

/** `git log --format=%x01%ct --name-only`: each file's newest commit time (keys lower case). */
export function lastCommitByFile(out: string): Map<string, number> {
  const seen = new Map<string, number>()
  let at = 0
  for (const l of out.split(/\r?\n/)) {
    if (l.startsWith('\u0001')) at = Number(l.slice(1)) * 1000
    else if (l.trim() && !seen.has(l.trim().toLowerCase())) seen.set(l.trim().toLowerCase(), at)
  }
  return seen
}

export type Branch = { name: string; at: number; upstream: string; ahead: number; behind: number; current: boolean }

/** `git branch --format=%(HEAD)%09%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)`. */
export function branchesFrom(out: string): Branch[] {
  return out
    .split(/\r?\n/)
    .map(l => l.split('\t'))
    .filter(p => p.length >= 3 && p[1])
    .map(p => ({
      name: p[1]!,
      at: Number(p[2]) * 1000,
      upstream: p[3] ?? '',
      ahead: Number(/ahead (\d+)/.exec(p[4] ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(p[4] ?? '')?.[1] ?? 0),
      current: p[0] === '*',
    }))
}

export type BlameRun = { from: number; to: number; sha: string; author: string; at: number; subject: string }

/** `git blame --porcelain`: the file as runs of lines from one commit each (an uncommitted line: sha of zeros). */
export function blameRuns(out: string): BlameRun[] {
  const info = new Map<string, { author: string; at: number; subject: string }>()
  const runs: BlameRun[] = []
  let sha = ''
  let line = 0
  for (const l of out.split(/\r?\n/)) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l)
    if (head) {
      sha = head[1]!
      line = Number(head[2])
      if (!info.has(sha)) info.set(sha, { author: '', at: 0, subject: '' })
      const last = runs[runs.length - 1]
      if (last && last.sha === sha && last.to === line - 1) last.to = line
      else runs.push({ from: line, to: line, sha, author: '', at: 0, subject: '' })
    } else if (l.startsWith('author ')) info.get(sha)!.author = l.slice(7)
    else if (l.startsWith('author-time ')) info.get(sha)!.at = Number(l.slice(12)) * 1000
    else if (l.startsWith('summary ')) info.get(sha)!.subject = l.slice(8)
  }
  return runs.map(r => ({ ...r, ...info.get(r.sha)! }))
}

export type GraphRow = { sha: string; parents: string[]; at: number; author: string; refs: string[]; subject: string; col: number; lanes: (string | null)[] }

/**
 * `git log --all --date-order --format=%H%x09%P%x09%ct%x09%an%x09%D%x09%s`, laid out in lanes: each commit's column,
 * and the lanes after it (which commit each lane waits for), so the graph can draw a line from row to row. A lane
 * keeps its column until it ends (no shuffling), so lines stay straight.
 */
export function graphRows(out: string): GraphRow[] {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const l of out.split(/\r?\n/)) {
    const p = l.split('\t')
    if (p.length < 6 || !/^[0-9a-f]{7,40}$/.test(p[0]!)) continue
    const sha = p[0]!
    const parents = p[1]!.split(' ').filter(Boolean)
    let col = lanes.indexOf(sha)
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.push(null) - 1
    }
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === sha) lanes[i] = null
    lanes[col] = parents[0] ?? null
    for (const q of parents.slice(1))
      if (!lanes.includes(q)) {
        let f = lanes.indexOf(null)
        if (f < 0) f = lanes.push(null) - 1
        lanes[f] = q
      }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const refs = p[4]!.split(', ').map(r => r.replace(/^HEAD -> /, '').replace(/^tag: /, '🏷 ')).filter(r => r && r !== 'HEAD' && !/\/HEAD$/.test(r))
    rows.push({ sha, parents, at: Number(p[2]) * 1000, author: p[3]!, refs, subject: p.slice(5).join('\t'), col, lanes: [...lanes] })
  }
  return rows
}

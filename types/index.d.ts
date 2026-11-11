/** The file open in the pane: whole (up to the pane's limit) or one page of a big file. */
export type OpenFile = {
  path: string;
  size: number;
  mtimeMs: number;
  /** whole: the file; page: bytes [start, end) of it. */
  mode: 'whole' | 'page';
  start: number;
  end: number;
  /** As shown (line ends as \n). */
  text: string;
  /** The file's own line ending, put back on save. */
  eol: '\n' | '\r\n';
  /** A UTF-8 byte order mark at the start, kept on save. */
  bom: boolean;
  binary: boolean;
};

/**
 * One tick or untick of a Markdown checkbox, as the pane logs it (`$.store` key `ticks`, newest first, every chat):
 * the file, the item's text, the headings above it, ticked (true) or unticked, when (ms), and the line as it now reads.
 */
/** A page of the Project view: the dashboard (overview) or one of its full pages. */
export type ProjectTab = 'overview' | 'next' | 'timeline' | 'items' | 'ticks' | 'features' | 'blocks' | 'changes' | 'git' | 'checks' | 'search' | 'backups' | 'log' | 'notes';
export type Tick = { path: string; item: string; headings: string[]; done: boolean; at: number; line: number; raw: string };

/** How a binary file shows (for `path`; another file starts at info, byte 0). */
/** Project → Git / Changes: 🔎 part of a path, one kind, the order, 📁 folders (with the open ones) or ☰ a list, its page. */
export type GitList = {
  find: string;
  kind: 'all' | 'changed' | 'new' | 'deleted';
  sort: 'path' | 'lines' | 'kind' | 'newest';
  folders: boolean;
  open: string[];
  page: number;
  /** Git only: the changed files, the commit history, or the branches (with one compared). */
  mode?: 'changes' | 'history' | 'branches';
  compare?: string;
};
export type BinView ={ path: string; mode: 'info' | 'text' | 'hex' | 'files' | 'java' | 'diff'; at: number };

/** A file Claude edited this session (from its Edit / Write / NotebookEdit calls). */
export type Change = {
  path: string;
  tool: string;
  at: number;
  n: number;
  /** A backup of the file from before Claude's first edit of it this session ('' when the file was new). */
  before?: string;
  /** A backup from before each of Claude's edits of it this session, oldest first (the last 20). */
  edits?: { at: number; before: string }[];
};
/**
 * What a text file's ± Diff compares it with: the last commit, one of its backups (`backup`, else the newest; against
 * another backup `versus` instead of the file now), before Claude's edits (`edit`: before which of them, 0 = the
 * first), or another file (`other`: the one opened before it).
 */
export type DiffBase = { path: string; base: 'commit' | 'backup' | 'claude' | 'other'; backup?: string; versus?: string; edit?: number; other?: string };
/** The last run of a project script (Checks). */
export type CheckResult = { ok: boolean; at: number; secs: number; summary: string; failures: string[]; tail: string };

declare module 'claude-code' {
  interface PluginState {
    'file-pane': {
      /** The folder listed (absolute). */
      dir: string;
      open: OpenFile | null;
      /** The last thing done or refused, shown under the title. */
      message: string;
      /** A long folder: the first row of the page shown (pages of 80). */
      shown: number;
      /** The backup the last save made (Revert puts it back). */
      lastBackup: string;
      /** Files, or the Project view of the session's folder. */
      view: 'files' | 'git' | 'project';
      projectTab: ProjectTab;
      /** Items: done ones shown too. */
      itemsAll: boolean;
      /** Sections / blocks flipped from their default (open in a short document, folded in a long one). */
      toggled: string[];
      /** A Markdown file shown as text to edit instead of as a document. */
      mdAsText: boolean;
      /** What is being edited in place: an item (path#line), a section (path#sec:key), an add box (path#add:heading). */
      editing: string;
      changes: Change[];
      /** The script running now (Checks), or ''. */
      running: string;
      results: Record<string, CheckResult>;
      /** Changes / Git: the files whose diff is shown. */
      diffOpen: string[];
      /** Changes / Git: how the file list is narrowed, sorted, grouped and paged. */
      gitList: GitList;
      /** The band above the prompt hidden (until /files). */
      bandHidden: boolean;
      pinned: string[];
      recent: string[];
      /** Every backup copy the pane made: the copy, the file it's of, when. */
      backupLog: { backup: string; original: string; at: number }[];
      /** Search: the last text looked for. */
      search: string;
      /** Log: only error and warning lines. */
      logErrorsOnly: boolean;
      /** Diffs drawn as two columns (before | after) instead of one. */
      sideBySide: boolean;
      /** 🔍 Closer on model previews: 1, 1.5 or 2 (the middle of the picture, drawn at the same size). */
      previewZoom: number;
      /** Ticks tab: every folder's ticks (true), or only this project's. */
      ticksAll: boolean;
      /** Diffs leave out changes in spaces, tabs, line endings and blank lines. */
      ignoreSpace: boolean;
      /** What the open text file's ± Diff compares it with. */
      diffBase: DiffBase;
      /** Long lines wrap onto more rows (true), or stay one row cut at the edge (false); every view. */
      wrap: boolean;
      /** The file whose note is being written. */
      noteOpen: string;
      /** A binary file's view: what it is (info), its readable text, its bytes, the files in a zip / jar, a class's
       * bytecode (java), or its diff against the last commit; `at` the byte a text / hex page starts at. */
      binView: BinView;
      /** Diffs show each line's number in the old and new file. */
      diffLineNumbers: boolean;
      /** Compact: shorter button labels, for a narrow pane. */
      compact: boolean;
      /** How a folder lists: by name (folders first), size or modified time (newest first). */
      sortBy: 'name' | 'size' | 'date';
      /** A folder list narrowed to names holding this text ('': all). */
      folderFind: string;
      /** ← → in the top bar: the places (folders, files) visited before and after this one. */
      nav: { back: string[]; fwd: string[] };
      /** The folder tree's open folders (lower-case paths). */
      treeOpen: string[];
      /** The top bar's ⋯ menu is open (Wrap, Follow, Compact, Go to, version, Tools). */
      menu: boolean;
      /** 👁 Follow Claude: the lines of a file Claude read last (shown above that file), or null. */
      /** 🕘 History of the open file: its commits, or who changed each line when (blame). */
      fileHist: { path: string; mode: 'log' | 'blame' } | null;
      agentRead: { path: string; from: number; to: number; at: number } | null;
      /** Claude edited a file while the pane held unsaved typing for it (`at` when), or null. */
      conflict: { path: string; at: number } | null;
      /** 🗂 Files inside a big zip: the part of a name looked for (`path` the zip it's for). */
      zipFilter: { path: string; text: string };
      /** A zip / jar's ± Diff: the file inside it whose own diff is shown (`path` the zip). */
      zipEntry: { path: string; name: string };
      /** The last tick / untick, for its Undo (line `line` of `path` now reads `raw`). */
      lastTick: Tick | null;
      /** Markdown files in ✎ Edit mode: a click on an item or heading edits it instead of ticking. */
      editMode: string[];
      /** Sections showing only open items (`<path>#<section key>`). */
      openOnly: string[];
    };
  }
  // the pane's own tools, until the engine's generated list (.claude-plugin/types/claude-code-mcp) has them: same
  // shape as its inputSchema, so the two merge once it does
  interface McpToolInputs {
    "mcp__file-pane__show": {
      /** The file to show (absolute) */
      path: string
      /** Show its diff against this */
      diff?: "commit" | "claude" | "backup"
      /** Point at this line (1-based): the pane says what it reads */
      line?: number
    }
    "mcp__file-pane__backups": {
      /** Only copies of this file, or of files under this folder (absolute) */
      path?: string
      /** At most this many (default 20, at most 200) */
      limit?: number
    }
    "mcp__file-pane__notes": {
      /** Only this file, or files under this folder (absolute) */
      path?: string
    }
    "mcp__file-pane__ticks": {
      /** Only this file, or files under this folder (absolute) */
      path?: string
      /** Only ticks at or after this time (ISO date or date-time) */
      since?: string
      /** At most this many (default 50, at most 500) */
      limit?: number
    }
  }
}

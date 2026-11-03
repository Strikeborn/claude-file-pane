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
export type Tick = { path: string; item: string; headings: string[]; done: boolean; at: number; line: number; raw: string };

/** How a binary file shows (for `path`; another file starts at info, byte 0). */
export type BinView = { path: string; mode: 'info' | 'text' | 'hex'; at: number };

/** A file Claude edited this session (from its Edit / Write / NotebookEdit calls). */
export type Change = { path: string; tool: string; at: number; n: number };
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
      /** How many entries of a long folder are shown. */
      shown: number;
      /** The backup the last save made (Revert puts it back). */
      lastBackup: string;
      /** Files, or the Project view of the session's folder. */
      view: 'files' | 'project';
      projectTab: 'next' | 'timeline' | 'items' | 'features' | 'blocks' | 'changes' | 'git' | 'checks' | 'search' | 'backups' | 'log' | 'notes';
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
      /** Long lines wrap onto more rows (true), or stay one row cut at the edge (false); every view. */
      wrap: boolean;
      /** The file whose note is being written. */
      noteOpen: string;
      /** A binary file's view: what it is (info), its readable text, or its bytes; `at` the byte its page starts at. */
      binView: BinView;
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

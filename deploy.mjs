// Deploy: check this folder, then copy it into the folder Claude Code loads (~/.claude/mods/file-pane, named by
// CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json). Work here; run `node deploy.mjs` to put a change live.
//   node deploy.mjs          checks (validate, typecheck when the engine's types are here, pane test, helper test), then copy
//   node deploy.mjs --check  checks only
//   node deploy.mjs --no-release   deploy without the git tag + GitHub release (scripts/release.mjs)
// The loaded copy is backed up first (~/.claude/file-pane-backups/deploy-<time>), so a bad deploy can be put back.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(os.homedir(), '.claude', 'mods', 'file-pane');
// what the mod is made of (the engine writes .claude-plugin/types itself, in each folder it loads)
const FILES = ['.claude-plugin/plugin.json', 'tsconfig.json', 'README.md', 'CLAUDE.md'];
const DIRS = ['hooks', 'types', 'tests'];

const run = (label, cmd, args) => {
  process.stdout.write(`${label}… `);
  try {
    // one fixed command line (claude and npx are .cmd shims on Windows, so they need a shell)
    execSync([cmd, ...args].join(' '), { cwd: src, stdio: 'pipe' });
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    console.log(String(e.stdout ?? '') + String(e.stderr ?? ''));
    process.exit(1);
  }
};

run('validate', 'claude', ['plugin', 'validate', '.']);
if (fs.existsSync(path.join(src, '.claude-plugin', 'types', 'tsconfig.json')))
  run('typecheck', 'npx', ['-y', '-p', 'typescript', 'tsc', '-p', '.', '--noEmit']);
else console.log('typecheck… skipped (no engine types here yet: they appear once a session loads this folder)');
run('pane test', 'claude', ['plugin', 'test', '.']);
run('helper test', 'node', ['--test', 'tests/helper.check.mjs']);
if (process.argv.includes('--check')) process.exit(0);

// back up what's loaded now
if (fs.existsSync(dest)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(os.homedir(), '.claude', 'file-pane-backups', `deploy-${stamp}`);
  fs.cpSync(dest, bak, { recursive: true });
  console.log(`backed up the loaded copy to ${bak}`);
}

// copy the mod's files; in its own folders, files no longer here are removed from the loaded copy (they're in the backup)
fs.mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  const from = path.join(src, f);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
  fs.copyFileSync(from, path.join(dest, f));
}
for (const d of DIRS) {
  fs.rmSync(path.join(dest, d), { recursive: true, force: true });
  if (fs.existsSync(path.join(src, d))) fs.cpSync(path.join(src, d), path.join(dest, d), { recursive: true });
}
// the stamp the pane shows in its header (version, when deployed) and compares to spot a newer deploy
const version = JSON.parse(fs.readFileSync(path.join(src, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const at = new Date().toISOString();
fs.writeFileSync(path.join(dest, 'deployed.json'), JSON.stringify({ version, at }) + '\n');
console.log(`deployed ${version} (${at}) to ${dest}: new chats load it, and open chats started with CLAUDE_CODE_PLUGIN_DIR_WATCH=1 reload it in a moment`);

// a tag and GitHub release for this version (when all is committed; once per version); --no-release skips it
if (!process.argv.includes('--no-release')) {
  try {
    execSync('node scripts/release.mjs', { cwd: src, stdio: 'inherit' });
  } catch {
    /* it said why; the deploy itself is done */
  }
}

// A git tag and a GitHub release (on the private repository) for the version in plugin.json, its notes from that
// version's CHANGELOG.md section. deploy.mjs runs it after a deploy; by hand: `node scripts/release.mjs`.
// Only when everything is committed (the tag must be what was deployed), and only once per version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, ...args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const tag = `v${version}`;

const done = (msg, code = 0) => {
  console.log(`release… ${msg}`);
  process.exit(code);
};
try {
  if (run('git', 'status', '--porcelain')) done(`skipped: uncommitted changes (commit, then node scripts/release.mjs)`);
  if (run('git', 'tag', '--list', tag)) done(`${tag} is already tagged`);
  // this version's notes: its CHANGELOG section, without the heading
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const at = log.search(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm'));
  const rest = at < 0 ? '' : log.slice(at).split('\n').slice(1).join('\n');
  const notes = (rest.split(/^## /m)[0] ?? '').trim() || `Files pane ${version}.`;
  run('git', 'tag', '-a', tag, '-m', `Files pane ${version}`);
  run('git', 'push', 'origin', tag);
  run('gh', 'release', 'create', tag, '--title', `Files pane ${version}`, '--notes', notes, '--verify-tag');
  done(`${tag} tagged and released on GitHub`);
} catch (e) {
  done(`not finished: ${String(e.stderr || e.message).trim().split('\n')[0]}`, 1);
}

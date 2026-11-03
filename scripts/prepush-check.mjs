// Before a push (git's pre-push hook, .githooks/pre-push): refuses when what's tracked, or a commit being pushed,
// carries this machine's user name, its home folder, an email other than GitHub's noreply one, or something shaped like
// a key or token (SECURITY.md finding 10). What counts as personal is read from this machine (its user name, the
// home folder, git's own email), so no list of personal words is kept in the repository.
//   node scripts/prepush-check.mjs           check the tracked files and the commits not on origin yet
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const user = os.userInfo().username;
const words = [user, os.homedir()].filter(w => w && w.length >= 3);
let email = '';
try {
  email = git('config', 'user.email');
} catch {
  /* none set */
}
const okEmail = (e) => /@users\.noreply\.github\.com$/i.test(e) || /^noreply@anthropic\.com$/i.test(e) || /@example\.(com|org)$/i.test(e);
if (email && !okEmail(email)) words.push(email);

const KEYS = [
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an Anthropic / OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const found = [];

// the tracked files as they are now (binary samples skipped by git grep -I)
for (const w of words) {
  let hits = '';
  try {
    hits = git('grep', '-I', '-n', '-i', '-F', '-e', w, '--', '.');
  } catch {
    /* no match: git grep exits 1 */
  }
  for (const h of hits.split('\n').filter(Boolean)) found.push(`${h.slice(0, h.indexOf(':', h.indexOf(':') + 1))}: this machine's ${w === email ? 'email' : w === user ? 'user name' : 'home folder'}`);
}
for (const [what, re] of KEYS) {
  let hits = '';
  try {
    hits = git('grep', '-I', '-n', '-P', '-e', re.source, '--', '.');
  } catch {
    /* no match */
  }
  for (const h of hits.split('\n').filter(Boolean)) found.push(`${h.slice(0, h.indexOf(':', h.indexOf(':') + 1))}: looks like ${what}`);
}
// emails on the commits not pushed yet
let range = 'HEAD';
try {
  git('rev-parse', '--verify', '@{u}');
  range = '@{u}..HEAD';
} catch {
  /* no upstream yet: every commit */
}
for (const line of git('log', '--format=%h %ae %ce', range).split('\n').filter(Boolean)) {
  const [h, a, c] = line.split(' ');
  for (const e of [a, c]) if (e && !okEmail(e)) found.push(`commit ${h}: email ${e} (use GitHub's noreply address)`);
}

if (found.length) {
  console.error('Not pushed: personal data or a key in what would go to GitHub (SECURITY.md finding 10):');
  for (const f of [...new Set(found)].slice(0, 50)) console.error(`  ${f}`);
  process.exit(1);
}
console.log('pre-push check: ok (no user name, home folder, personal email or key-shaped text)');

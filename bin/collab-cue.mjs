#!/usr/bin/env node
/**
 * collab-cue — a cue-based review protocol for two agents sharing one file.
 *
 * The file protocol is the contract; this CLI is a convenience over it:
 *   collab/cue.json            { protocol, from, kind, note, sha, at, final, expect[] }
 *   collab/ack.<agent>.json    { sha, at }        what that agent has consumed
 *   collab/state.<agent>.json  { lastReviewedSha, at, round }
 *
 * Design decisions from the review round that shaped this:
 *   G-13  append/ack/selftest/--json/--final exist as primitives, not habits.
 *   G-14  the gate's id set is an input (`ring --expect`), never derived from prose.
 *   G-15  zero dependencies, runnable as `node bin/collab-cue.mjs`, npm later.
 *   G-16  close refuses while anything is open; there is no --force.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL = 1;
const HEADER = 9;

function die(message, code = 1) {
  process.stderr.write(`collab-cue: ${message}\n`);
  process.exit(code);
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function paths(root) {
  const dir = path.join(root, 'collab');
  return {
    dir,
    report: path.join(root, 'PROJECT_REPORT.md'),
    cue: path.join(dir, 'cue.json'),
    ack: (as) => path.join(dir, `ack.${as}.json`),
    state: (as) => path.join(dir, `state.${as}.json`),
  };
}

const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function lastAuthor(text) {
  let author = 'unknown';
  for (const line of text.split(/\r?\n/)) {
    const m = /^###\s+(.+)$/.exec(line);
    if (!m) continue;
    if (/\bDSH\b/i.test(m[1])) author = 'dsh';
    else if (/\bAntigravity\b/i.test(m[1])) author = 'antigravity';
    else if (/\bGemini\b/i.test(m[1])) author = 'gemini';
  }
  return author;
}

const trimStart = (line) => line.replace(/^[\s>|*`#-]+/, '');
const VERDICT = /\b(ACCEPT|REBUT|DEFER)\b/;

function missingAnswers(text, ids) {
  const lines = text.split(/\r?\n/);
  return ids.filter((id) => {
    const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return !lines.some((line) => re.test(line) && trimStart(line).startsWith(id) && VERDICT.test(line));
  });
}

/* ------------------------------------------------------------------ commands */

function cmdInit({ root }) {
  const p = paths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(p.report)) {
    fs.writeFileSync(p.report, '# Collaboration report\n\n## Log\n', 'utf8');
  }
  writeJson(p.cue, { protocol: PROTOCOL, from: null, sha: null, at: null, final: false, expect: [] });
  process.stdout.write(`initialised ${p.dir} (protocol ${PROTOCOL})\n`);
}

function cmdRing({ root, as, kind = 'notes', note = '', expect = '', final = false }) {
  const p = paths(root);
  if (!as) die('--as is required');
  const text = fs.readFileSync(p.report, 'utf8');
  const cue = {
    protocol: PROTOCOL,
    from: as,
    kind,
    note,
    sha: sha256(Buffer.from(text, 'utf8')),
    at: new Date().toISOString(),
    final: Boolean(final),
    expect: expect ? String(expect).split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
  writeJson(p.cue, cue);
  process.stdout.write(`rung by ${as} (${cue.expect.length} expected id(s))\n`);
}

function cmdStatus({ root, as, json }) {
  const p = paths(root);
  const cue = readJson(p.cue);
  const ack = readJson(p.ack(as), { sha: null });
  const rung = Boolean(cue && cue.from && cue.from !== as && cue.sha !== ack.sha);
  if (json) {
    process.stdout.write(JSON.stringify({ as, state: rung ? 'rung' : 'quiet', from: cue?.from ?? null, sha: cue?.sha ?? null, expect: cue?.expect ?? [] }) + '\n');
  } else {
    process.stdout.write(`CUE as=${as} state=${rung ? 'rung' : 'quiet'} from=${cue?.from ?? '-'} expect=${(cue?.expect ?? []).join(',') || '-'}\n`);
  }
  process.exit(rung ? 0 : 0);
}

function cmdGate({ root, as, files }) {
  const p = paths(root);
  const text = fs.readFileSync(p.report, 'utf8');
  const sha = sha256(Buffer.from(text, 'utf8'));
  const age = Math.round((Date.now() - fs.statSync(p.report).mtimeMs) / 1000);
  const state = readJson(p.state(as), { lastReviewedSha: null });
  const cue = readJson(p.cue, { expect: [] });
  const ids = files ? String(files).split(',').map((s) => s.trim()).filter(Boolean) : (cue.expect ?? []);
  const missing = missingAnswers(text, ids);
  const author = lastAuthor(text);
  const notMe = author !== as;
  const fresh = sha !== state.lastReviewedSha;
  const settled = !cue.sha || cue.final || cue.sha === sha ? age >= 1 : age >= 180;
  const ready = fresh && settled && notMe && missing.length === 0;
  const reason = !fresh ? 'no-new-content' : !settled ? 'still-changing' : !notMe ? 'waiting-for-counterpart' : missing.length ? 'answers-incomplete' : 'ready';
  process.stdout.write(`STATE ready=${ready ? 'yes' : 'no'} new=${fresh ? 'yes' : 'no'} settled=${settled ? 'yes' : 'no'} age=${age}s lastAuthor=${author} reason=${reason} missing=${missing.length ? missing.join(',') : 'none'}\n`);
  process.exit(ready ? 0 : 1);
}

function cmdAck({ root, as }) {
  const p = paths(root);
  const cue = readJson(p.cue, { sha: null });
  writeJson(p.ack(as), { sha: cue.sha, at: new Date().toISOString() });
  process.stdout.write(`acked as ${as}\n`);
}

function cmdCommit({ root, as }) {
  const p = paths(root);
  const sha = sha256(fs.readFileSync(p.report));
  const prev = readJson(p.state(as), { round: 0 });
  writeJson(p.state(as), { lastReviewedSha: sha, at: new Date().toISOString(), round: (prev.round ?? 0) + 1 });
  process.stdout.write(`committed ${as} round=${(prev.round ?? 0) + 1}\n`);
}

/**
 * The only sanctioned way to add an entry (G-13). Three rules, each of which was a real defect:
 *   no control bytes   -> R-41 corrupted an entry with 0x08/0x09/0x0B
 *   no '###' inside    -> a trailing subheading broke author detection (P-2)
 *   always at EOF      -> a mid-file append inserted an entry above the counterpart's (Round 11)
 */
function cmdAppend({ root, as, file }) {
  const p = paths(root);
  let body = file && file !== true ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  body = body.replace(/^\uFEFF/, '');

  const bad = [...body].filter((ch) => {
    const c = ch.codePointAt(0);
    return (c < 9 || (c > 13 && c < 32)) && c !== 0;
  });
  if (bad.length) die(`refusing to append: ${bad.length} ASCII control byte(s) (R-41)`);

  const inner = body.split(/\r?\n/).filter((l) => /^###\s/.test(l));
  if (inner.length) die(`refusing to append: ${inner.length} '###' heading(s) inside the entry; use '####' (P-2)`);

  const existing = fs.existsSync(p.report) ? fs.readFileSync(p.report, 'utf8') : '';
  const sep = existing.endsWith('\n') ? '' : '\n';
  const entry = body.startsWith('\n') ? body : `\n${body}`;
  fs.appendFileSync(p.report, sep + entry + (entry.endsWith('\n') ? '' : '\n'), 'utf8');
  process.stdout.write(`appended ${body.length} bytes at EOF as ${as ?? 'unknown'}\n`);
}

function cmdTail({ root, as }) {
  const p = paths(root);
  const lines = fs.readFileSync(p.report, 'utf8').split(/\r?\n/);
  let start = 0;
  lines.forEach((line, i) => {
    const m = /^###\s+(.+)$/.exec(line);
    if (!m) return;
    const mine = (as === 'dsh' && /\bDSH\b/i.test(m[1])) || (as === 'antigravity' && /\bAntigravity\b/i.test(m[1]));
    if (!mine) start = i;
  });
  process.stdout.write(lines.slice(start).join('\n'));
}

function cmdClose({ root, as, open }) {
  if (open && String(open) !== '0') die(`refusing to close: ${open} H/M finding(s) open (G-16)`, 1);
  const p = paths(root);
  const text = [
    '',
    '## COLLAB CLOSED',
    '',
    `- Closed by: ${as ?? 'unknown'}`,
    `- Open findings: ${open ?? '0'}`,
    `- At: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  fs.appendFileSync(p.report, text, 'utf8');
  process.stdout.write('closed\n');
}

/* ------------------------------------------------------------------ selftest */

function cmdSelftest() {
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok });

  const report = [
    '### DSH — x',
    '| R-1 | ACCEPT | ok |',
    '| **R-2** | REBUT | no |',
    '- R-3: DEFER',
    'prose mentioning R-4 and ACCEPT',
  ].join('\n');
  t('answer rows are found', missingAnswers(report, ['R-1', 'R-2', 'R-3']).length === 0);
  t('prose is not an answer', missingAnswers(report, ['R-4']).length === 1);
  t('bold ids count', missingAnswers('| **G-7** | ACCEPT | ok |', ['G-7']).length === 0);
  t('lowercase verdict does not count', missingAnswers('| R-9 | accept | x |', ['R-9']).length === 1);

  const entry = '### Antigravity — 2026-11-11\n- body\n#### sub\n';
  t('author survives a subheading', /\bAntigravity\b/.test(entry) && !/^###\s+sub/m.test(entry));

  const control = 'bad \u0008 byte';
  t('control bytes are detected', [...control].some((ch) => ch.codePointAt(0) === 8));

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) process.stdout.write(`SELFTEST ${c.ok ? 'PASS' : 'FAIL'} ${c.name}\n`);
  process.stdout.write(`SELFTEST RESULT ${failed.length ? `fail=${failed.length}` : 'pass'}\n`);
  process.exit(failed.length ? 1 : 0);
}

/* ------------------------------------------------------------------ main */

const argv = process.argv.slice(2);
const cmd = argv[0];
const f = flags(argv.slice(1));
const root = f.root && f.root !== true ? f.root : process.cwd();
const as = f.as && f.as !== true ? f.as : undefined;

switch (cmd) {
  case 'init': cmdInit({ root }); break;
  case 'ring': cmdRing({ root, as, kind: f.kind, note: f.note, expect: f.expect, final: f.final }); break;
  case 'status': cmdStatus({ root, as, json: f.json }); break;
  case 'gate': cmdGate({ root, as, files: f.ids }); break;
  case 'ack': cmdAck({ root, as }); break;
  case 'commit': cmdCommit({ root, as }); break;
  case 'append': cmdAppend({ root, as, file: f.file }); break;
  case 'tail': cmdTail({ root, as }); break;
  case 'close': cmdClose({ root, as, open: f.open }); break;
  case 'selftest': cmdSelftest(); break;
  default:
    process.stdout.write('collab-cue <init|ring|status|gate|ack|commit|append|tail|close|selftest> [--root dir] [--as agent] [--expect ids] [--final] [--json] [--file path] [--open n] [--ids ids]\n');
    process.exit(cmd ? 1 : 0);
}

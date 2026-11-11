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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROTOCOL = 1;
const SETTLE_SECONDS = 180;
const AS_RE = /^[A-Za-z0-9_-]+$/;

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

/** A boolean flag: bare `--final` is true; `--final false|0|no` is false. */
const flag = (v) => v === true || (typeof v === 'string' && !/^(false|0|no)$/i.test(v));

/** --as names a file (ack.<as>.json), so it is restricted to a safe charset. */
function needAs(as) {
  if (!as) die('--as is required');
  if (!AS_RE.test(as)) die(`--as must match ${AS_RE} (got '${as}')`);
  return as;
}

function paths(root, report = 'PROJECT_REPORT.md') {
  const dir = path.join(root, 'collab');
  return {
    dir,
    report: path.resolve(root, report),
    cue: path.join(dir, 'cue.json'),
    ack: (as) => path.join(dir, `ack.${as}.json`),
    state: (as) => path.join(dir, `state.${as}.json`),
  };
}

/** Missing file -> fallback. A file that exists but is unreadable or not JSON is a hard error:
 *  swallowing it would make a corrupt cue read as "quiet" and the bell would never ring. */
function readJson(file, fallback = null) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    die(`cannot read ${file}: ${e.message}`);
  }
  try { return JSON.parse(raw); } catch { die(`${file} is not valid JSON; repair or delete it`); }
}

/** Atomic: a reader sees the old file or the new one, never half of it. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The report as raw bytes + decoded text. Every hash in this tool is over the raw bytes, so ring,
 *  gate and commit always agree. */
function readReport(p) {
  let buf;
  try { buf = fs.readFileSync(p.report); }
  catch (e) {
    if (e.code === 'ENOENT') die(`${p.report} not found (run \`collab-cue init\`)`);
    die(`cannot read ${p.report}: ${e.message}`);
  }
  return { buf, text: buf.toString('utf8'), sha: sha256(buf) };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text of the last `### ` heading (an entry heading), or null. `####` never matches. */
function lastHeading(text) {
  let heading = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^###\s+(.+)$/.exec(line);
    if (m) heading = m[1];
  }
  return heading;
}

/** Does this heading name `as`? Whole-token, case-insensitive, so any agent name works. */
const isMine = (heading, as) =>
  heading !== null && new RegExp(`(^|[^\\w-])${esc(as)}($|[^\\w-])`, 'i').test(heading);

function authorOf(heading, as) {
  if (heading === null) return 'unknown';
  if (isMine(heading, as)) return as;
  return /[\w-]+/.exec(heading)?.[0].toLowerCase() ?? 'unknown';
}

const trimStart = (line) => line.replace(/^[\s>|*`#-]+/, '');
const VERDICT = /\b(ACCEPT|REBUT|DEFER)\b/;

/** An id is answered by a line that begins with it (after table/bullet/bold decoration), as a whole
 *  token (R-1 is not answered by R-10), and carries an upper-case verdict after it. */
function missingAnswers(text, ids) {
  const lines = text.split(/\r?\n/).map(trimStart);
  return ids.filter((id) => {
    const start = new RegExp(`^${esc(id)}(?![\\w-])`);
    return !lines.some((line) => start.test(line) && VERDICT.test(line.slice(id.length)));
  });
}

const parseIds = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

/* ------------------------------------------------------------------ commands */

function cmdInit({ root, report }) {
  const p = paths(root, report);
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(p.report)) {
    fs.writeFileSync(p.report, '# Collaboration report\n\n## Log\n', 'utf8');
  }
  writeJson(p.cue, { protocol: PROTOCOL, from: null, sha: null, at: null, final: false, expect: [] });
  process.stdout.write(`initialised ${p.dir} (protocol ${PROTOCOL})\n`);
}

function cmdRing({ root, report, as, kind = 'notes', note = '', expect, final }) {
  needAs(as);
  const p = paths(root, report);
  const cue = {
    protocol: PROTOCOL,
    from: as,
    kind,
    note,
    sha: readReport(p).sha,
    at: new Date().toISOString(),
    final: flag(final),
    expect: parseIds(expect === true ? '' : expect),
  };
  writeJson(p.cue, cue);
  process.stdout.write(`rung by ${as} (${cue.expect.length} expected id(s)${cue.final ? ', final' : ''})\n`);
}

function cmdStatus({ root, report, as, json }) {
  needAs(as);
  const p = paths(root, report);
  const cue = readJson(p.cue);
  const ack = readJson(p.ack(as), { sha: null });
  const rung = Boolean(cue && cue.from && cue.from !== as && cue.sha !== ack.sha);
  if (json) {
    process.stdout.write(JSON.stringify({ as, state: rung ? 'rung' : 'quiet', from: cue?.from ?? null, sha: cue?.sha ?? null, expect: cue?.expect ?? [] }) + '\n');
  } else {
    process.stdout.write(`CUE as=${as} state=${rung ? 'rung' : 'quiet'} from=${cue?.from ?? '-'} expect=${(cue?.expect ?? []).join(',') || '-'}\n`);
  }
}

function cmdGate({ root, report, as, ids }) {
  needAs(as);
  const p = paths(root, report);
  const { text, sha } = readReport(p);
  const age = Math.round((Date.now() - fs.statSync(p.report).mtimeMs) / 1000);
  const state = readJson(p.state(as), { lastReviewedSha: null });
  const cue = readJson(p.cue, { expect: [] });
  const want = ids && ids !== true ? parseIds(ids) : (cue.expect ?? []);
  const missing = missingAnswers(text, want);
  const heading = lastHeading(text);
  const author = authorOf(heading, as);
  const notMe = !isMine(heading, as);
  const fresh = sha !== state.lastReviewedSha;
  // A finished writer may retire the settle window, but only for the exact bytes it rang for.
  const finalForThis = Boolean(cue.final) && cue.sha === sha;
  const settled = finalForThis || age >= SETTLE_SECONDS;
  const ready = fresh && settled && notMe && missing.length === 0;
  const reason = !fresh ? 'no-new-content' : !settled ? 'still-changing' : !notMe ? 'waiting-for-counterpart' : missing.length ? 'answers-incomplete' : 'ready';
  process.stdout.write(`STATE ready=${ready ? 'yes' : 'no'} new=${fresh ? 'yes' : 'no'} settled=${settled ? 'yes' : 'no'} age=${age}s lastAuthor=${author} reason=${reason} missing=${missing.length ? missing.join(',') : 'none'}\n`);
  process.exit(ready ? 0 : 1);
}

function cmdAck({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const cue = readJson(p.cue, { sha: null });
  writeJson(p.ack(as), { sha: cue.sha, at: new Date().toISOString() });
  process.stdout.write(`acked as ${as}\n`);
}

function cmdCommit({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const { sha } = readReport(p);
  const prev = readJson(p.state(as), { round: 0 });
  const round = (prev.round ?? 0) + 1;
  writeJson(p.state(as), { lastReviewedSha: sha, at: new Date().toISOString(), round });
  process.stdout.write(`committed ${as} round=${round}\n`);
}

/**
 * The only sanctioned way to add an entry (G-13). Three rules, each of which was a real defect:
 *   no control bytes   -> R-41 corrupted an entry with 0x08/0x09/0x0B
 *   one '###' at most  -> the entry's own heading; a later one broke author detection (P-2)
 *   always at EOF      -> a mid-file append inserted an entry above the counterpart's (Round 11)
 */
function cmdAppend({ root, report, as, file }) {
  needAs(as);
  const p = paths(root, report);
  let body;
  try { body = file && file !== true ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8'); }
  catch (e) { die(`cannot read entry: ${e.message}`); }
  body = body.replace(/^﻿/, '');
  if (!body.trim()) die('refusing to append: empty entry');

  // Allowed: TAB, LF, CR and printable text. Rejected: NUL, 0x01-0x08, VT, FF, 0x0E-0x1F, DEL (R-41 included 0x0B).
  const bad = [...body].filter((ch) => {
    const c = ch.codePointAt(0);
    return c < 9 || c === 11 || c === 12 || (c > 13 && c < 32) || c === 127;
  });
  if (bad.length) die(`refusing to append: ${bad.length} ASCII control byte(s) (R-41)`);

  // The entry's own heading must be its first non-blank line; any other `###` is refused.
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  const inner = lines.filter((l, i) => /^###\s/.test(l) && i !== first);
  if (inner.length) die(`refusing to append: ${inner.length} extra '###' heading(s) inside the entry; only the first line may be '###', use '####' below it (P-2)`);

  const existing = fs.existsSync(p.report) ? fs.readFileSync(p.report, 'utf8') : '';
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const entry = body.startsWith('\n') ? body : `\n${body}`;
  fs.appendFileSync(p.report, sep + entry + (entry.endsWith('\n') ? '' : '\n'), 'utf8');
  process.stdout.write(`appended ${Buffer.byteLength(body, 'utf8')} bytes at EOF as ${as}\n`);
}

function cmdTail({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const lines = readReport(p).text.split(/\r?\n/);
  let start = 0;
  lines.forEach((line, i) => {
    const m = /^###\s+(.+)$/.exec(line);
    if (m && !isMine(m[1], as)) start = i;
  });
  process.stdout.write(lines.slice(start).join('\n'));
}

/** G-16: no --force. --open is mandatory, and the cue's expected ids must all be answered, so
 *  "nothing open" is checked against the report, not just claimed. */
function cmdClose({ root, report, as, open }) {
  needAs(as);
  if (open === undefined || open === true) die('refusing to close: --open <n> is required (G-16)');
  if (!/^\d+$/.test(String(open))) die(`refusing to close: --open must be a non-negative integer (got '${open}')`);
  if (Number(open) > 0) die(`refusing to close: ${open} H/M finding(s) open (G-16)`);
  const p = paths(root, report);
  const cue = readJson(p.cue, { expect: [] });
  const missing = missingAnswers(readReport(p).text, cue.expect ?? []);
  if (missing.length) die(`refusing to close: expected id(s) not answered: ${missing.join(',')} (G-16)`);
  const text = [
    '',
    '## COLLAB CLOSED',
    '',
    `- Closed by: ${as}`,
    `- Open findings: ${open}`,
    `- At: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  fs.appendFileSync(p.report, text, 'utf8');
  process.stdout.write('closed\n');
}

/* ------------------------------------------------------------------ selftest */

/** Drives the real CLI in a temp directory, so what is tested is what ships. */
function cmdSelftest() {
  const self = fileURLToPath(import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cue-'));
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok: Boolean(ok) });
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [self, ...args, '--root', dir], { input, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const cue = () => JSON.parse(rd('collab/cue.json'));

  try {
    // answer detection (pure)
    const rows = ['| R-1 | ACCEPT | ok |', '| **R-2** | REBUT | no |', '- R-3: DEFER', 'prose mentioning R-4 and ACCEPT', '| R-10 | ACCEPT | x |', '| R-6 | accept | x |', 'ACCEPT R-7'].join('\n');
    t('answer rows are found', missingAnswers(rows, ['R-1', 'R-2', 'R-3']).length === 0);
    t('prose is not an answer', missingAnswers(rows, ['R-4']).length === 1);
    t('R-1 is not answered by R-10', missingAnswers('| R-10 | ACCEPT | x |', ['R-1']).length === 1);
    t('lowercase verdict does not count', missingAnswers(rows, ['R-6']).length === 1);
    t('verdict before the id does not count', missingAnswers(rows, ['R-7']).length === 1);

    // init / append
    t('init succeeds', run(['init']).code === 0);
    t('append accepts an entry with its own ### heading', run(['append', '--as', 'dsh'], '### DSH — round\n- R-1 ACCEPT\n#### sub\n').code === 0);
    t('append lands at EOF', rd('PROJECT_REPORT.md').endsWith('#### sub\n'));
    t('append refuses a second ### heading', run(['append', '--as', 'dsh'], '### A\nbody\n### B\n').code !== 0);
    t('append refuses NUL', run(['append', '--as', 'dsh'], 'a\0b\n').code !== 0);
    t('append refuses ESC', run(['append', '--as', 'dsh'], 'a\x1bb\n').code !== 0);
    t('append refuses VT', run(['append', '--as', 'dsh'], 'a\x0bb\n').code !== 0);
    t('append refuses DEL', run(['append', '--as', 'dsh'], 'a\x7fb\n').code !== 0);
    t('append refuses an empty entry', run(['append', '--as', 'dsh'], '\n \n').code !== 0);

    // flags and --as
    t('--as is required', run(['status']).code !== 0);
    t('--as rejects path characters', run(['status', '--as', '../x']).code !== 0);
    run(['ring', '--as', 'dsh', '--final', 'false']);
    t('--final false is false', cue().final === false);
    run(['ring', '--as', 'dsh', '--final']);
    t('bare --final is true', cue().final === true);

    // gate: final is bound to the sha it was rung for
    const g1 = run(['gate', '--as', 'other', '--ids', 'R-1']);
    t('final retires the settle window for matching bytes', /settled=yes/.test(g1.out));
    run(['append', '--as', 'dsh'], '#### late edit\n');
    t('final does not apply after the file changed', /settled=no/.test(run(['gate', '--as', 'other']).out));

    // gate: authorship is generic, not a hard-coded agent list
    run(['append', '--as', 'zed'], '### Zed — x\n');
    run(['ring', '--as', 'zed', '--final']);
    t('last author is detected for any name', /lastAuthor=zed .*reason=waiting-for-counterpart/.test(run(['gate', '--as', 'zed']).out));
    t('counterpart sees it as ready', /ready=yes/.test(run(['gate', '--as', 'amy']).out));
    t('missing report is a clean error', (() => { const r = run(['ring', '--as', 'a', '--report', 'nope.md']); return r.code !== 0 && !/\n\s+at /.test(r.err); })());

    // close cannot be bypassed
    run(['ring', '--as', 'dsh', '--expect', 'R-5']);
    t('close needs --open', run(['close', '--as', 'dsh']).code !== 0);
    t('close refuses --open > 0', run(['close', '--as', 'dsh', '--open', '2']).code !== 0);
    t('close refuses unanswered expected ids', run(['close', '--as', 'dsh', '--open', '0']).code !== 0);
    run(['append', '--as', 'dsh'], '### DSH — answers\n| R-5 | ACCEPT | ok |\n');
    t('close succeeds once answered', run(['close', '--as', 'dsh', '--open', '0']).code === 0 && /COLLAB CLOSED/.test(rd('PROJECT_REPORT.md')));

    // a corrupt cue fails loudly
    fs.writeFileSync(path.join(dir, 'collab/cue.json'), '{bad');
    t('corrupt cue is an error, not quiet', run(['status', '--as', 'me']).code !== 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) process.stdout.write(`SELFTEST ${c.ok ? 'PASS' : 'FAIL'} ${c.name}\n`);
  process.stdout.write(`SELFTEST RESULT ${failed.length ? `fail=${failed.length}` : 'pass'}\n`);
  process.exit(failed.length ? 1 : 0);
}

/* ------------------------------------------------------------------ main */

const argv = process.argv.slice(2);
const cmd = argv[0];
const f = flags(argv.slice(1));
const str = (v) => (v && v !== true ? v : undefined);
const root = str(f.root) ?? process.cwd();
const report = str(f.report);
const as = str(f.as);

switch (cmd) {
  case 'init': cmdInit({ root, report }); break;
  case 'ring': cmdRing({ root, report, as, kind: str(f.kind), note: str(f.note), expect: f.expect, final: f.final }); break;
  case 'status': cmdStatus({ root, report, as, json: f.json }); break;
  case 'gate': cmdGate({ root, report, as, ids: f.ids }); break;
  case 'ack': cmdAck({ root, report, as }); break;
  case 'commit': cmdCommit({ root, report, as }); break;
  case 'append': cmdAppend({ root, report, as, file: f.file }); break;
  case 'tail': cmdTail({ root, report, as }); break;
  case 'close': cmdClose({ root, report, as, open: f.open }); break;
  case 'selftest': cmdSelftest(); break;
  default:
    process.stdout.write('collab-cue <init|ring|status|gate|ack|commit|append|tail|close|selftest> [--root dir] [--report file] [--as agent] [--expect ids] [--final] [--json] [--file path] [--open n] [--ids ids]\n');
    process.exit(cmd ? 1 : 0);
}

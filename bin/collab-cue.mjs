#!/usr/bin/env node
/**
 * collab-cue — a cue-based review protocol for two agents sharing one file.
 *
 * The file protocol is the contract; this CLI is a convenience over it:
 *   collab/cue.json            { protocol, seq, from, kind, note, sha, at, final, expect[] }
 *   collab/ack.<agent>.json    { sha, seq, at }   what that agent has consumed
 *   collab/state.<agent>.json  { lastReviewedSha, at, round }
 *
 * Design decisions from the review round that shaped this:
 *   G-13  append/ack/selftest/--json/--final exist as primitives, not habits.
 *   G-14  the gate's id set is an input (`ring --expect`), never derived from prose.
 *   G-15  zero dependencies, runnable as `node bin/collab-cue.mjs`, npm later.
 *   G-16  close refuses while anything is open; there is no --force.
 *
 * Exit codes: 0 ok · 1 blocked (gate not ready, a guard refused) · 2 error (bad usage, bad files)
 *             · 3 timeout (`wait` ran out of time with nothing rung).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL = 1;
const SETTLE_SECONDS = 180;
const AS_RE = /^[A-Za-z0-9_-]+$/;

/* ------------------------------------------------------------------ io + exit
 * Commands never call process.exit; they throw Exit. That lets selftest drive the real command
 * set in-process (no child processes, so it also runs inside sandboxes that forbid spawning). */

class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

let io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdin: () => {
    if (process.stdin.isTTY) die('no entry on stdin: pipe one in, or pass --file <path>');
    return fs.readFileSync(0, 'utf8');
  },
};

/** An error: bad usage, unreadable or corrupt files. Exit 2. */
function die(message, code = 2) {
  io.err(`collab-cue: ${message}\n`);
  throw new Exit(code);
}
/** A guard said no. Exit 1, the same code as "gate not ready": blocked, not broken. */
const refuse = (message) => die(message, 1);

/* ------------------------------------------------------------------ flags */

// [value flags, boolean flags] per command. Anything else is an error, so a typo or an `=` form
// can never silently disable a check (F1).
const CMDS = {
  init: [[], []],
  ring: [['as', 'kind', 'note', 'expect'], ['final']],
  status: [['as'], ['json']],
  wait: [['as', 'timeout', 'poll'], []],
  next: [['as'], []],
  brief: [['as'], []],
  gate: [['as', 'ids'], []],
  ack: [['as'], []],
  commit: [['as'], []],
  append: [['as', 'file'], []],
  tail: [['as'], []],
  close: [['as', 'open'], []],
  selftest: [[], []],
};
const COMMON = ['root', 'report'];
const BOOL_WORD = /^(true|false|0|1|yes|no)$/i;

function parseFlags(cmd, argv) {
  const [values, bools] = CMDS[cmd];
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument '${a}'`);
    const eq = a.indexOf('=');
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
    let val = eq < 0 ? undefined : a.slice(eq + 1);
    if (bools.includes(key)) {
      if (val === undefined) {
        if (argv[i + 1] !== undefined && BOOL_WORD.test(argv[i + 1])) val = argv[++i];
        else val = 'true';
      }
      out[key] = !/^(false|0|no)$/i.test(val);
    } else if (values.includes(key) || COMMON.includes(key)) {
      if (val === undefined) {
        val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) die(`--${key} needs a value`);
        i++;
      }
      out[key] = val;
    } else {
      die(`unknown flag --${key} for '${cmd}'`);
    }
  }
  return out;
}

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

/* ------------------------------------------------------------------ files */

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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Atomic: a reader sees the old file or the new one, never half of it. The temp name is unique
 *  per call, and a rename that an antivirus scan or indexer briefly blocks is retried (F13). */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (attempt < 5 && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { sleep(100); continue; }
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  }
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

/* ------------------------------------------------------------------ the report's structure */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Entry headings (`### ...`) outside fenced code blocks (F10). `####` and deeper never count. */
function scan(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const ch = f[1][0];
      const len = f[1].length;
      if (!fence) fence = { ch, len };
      else if (fence.ch === ch && len >= fence.len && line.slice(f[0].length).trim() === '') fence = null;
      return;
    }
    if (fence) return;
    const m = /^###\s+(.+)$/.exec(line);
    if (m) heads.push({ i, text: m[1].trim() });
  });
  return { lines, heads };
}

/** `Correction (DSH) — ...` is DSH's heading (HOOK.md §2.3); read it as `DSH — ...`. */
const headingBody = (h) => h.replace(/^Correction\s*\(([^)]*)\)\s*/i, '$1 ');

/** Does this heading name `as`? The name must lead the heading and end at a word boundary, so
 *  `DSH-2` and `DSH (Correction)` are DSH, and `DSHS` is not. (A name that is a prefix of another
 *  hyphenated name, `ci` vs `ci-bot`, is ambiguous: pick distinct names.) */
function isMine(heading, as) {
  if (heading == null) return false;
  const b = headingBody(heading).toLowerCase();
  const a = as.toLowerCase();
  return b.startsWith(a) && !/[a-z0-9_]/.test(b[a.length] ?? '');
}

function authorOf(heading, as) {
  if (heading == null) return 'unknown';
  if (isMine(heading, as)) return as;
  return /^[A-Za-z0-9_]+/.exec(headingBody(heading))?.[0].toLowerCase() ?? 'unknown';
}

/** Entries as {heading, lines}; text before the first heading belongs to no entry. */
function entries(text) {
  const { lines, heads } = scan(text);
  return heads.map((h, k) => ({ heading: h.text, start: h.i, lines: lines.slice(h.i, heads[k + 1]?.i ?? lines.length) }));
}

/** The trailing run of entries whose heading satisfies `pred`: one writer's latest turn. */
function trailingRun(es, pred) {
  let i = es.length;
  while (i > 0 && pred(es[i - 1].heading)) i--;
  return es.slice(i);
}

const trimStart = (line) => line.replace(/^[\s>|*`#-]+/, '');
const VERDICT = /\b(ACCEPT|REBUT|DEFER)\b/;

/** Is `id` answered on one of these lines? A table row answers when its first cell is the id and
 *  its second cell *leads* with an upper-case verdict (so a finding row whose prose says ACCEPT is
 *  not its own answer). Any other line answers when it begins with the id as a whole token and
 *  carries a verdict after it. */
function isAnswered(lines, id) {
  const start = new RegExp(`^${esc(id)}(?![\\w-])`);
  return lines.some((raw) => {
    const line = raw.trim();
    if (line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.replace(/[*_`]/g, '').trim());
      return cells.length >= 2 && start.test(cells[0]) && /^(ACCEPT|REBUT|DEFER)\b/.test(cells[1]);
    }
    const t = trimStart(line);
    return start.test(t) && VERDICT.test(t.slice(id.length));
  });
}

/** Ids not yet answered *in the writer's latest turn* (F9): an old answer, or a finding's own row,
 *  never satisfies a new request. `writer(heading)` picks whose turn that is. */
function missingAnswers(text, ids, writer) {
  if (!ids.length) return [];
  const lines = trailingRun(entries(text), writer).flatMap((e) => e.lines);
  return ids.filter((id) => !isAnswered(lines, id));
}

const parseIds = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

/* ------------------------------------------------------------------ commands */

const isClosed = (text) => text.lastIndexOf('\n## COLLAB CLOSED') > text.lastIndexOf('\n## COLLAB REOPENED');

function cmdInit({ root, report }) {
  const p = paths(root, report);
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(p.report)) fs.writeFileSync(p.report, '# Collaboration report\n\n## Log\n', 'utf8');
  if (!fs.existsSync(p.cue)) writeJson(p.cue, { protocol: PROTOCOL, seq: 0, from: null, sha: null, at: null, final: false, expect: [] });
  io.out(`initialised ${p.dir} (protocol ${PROTOCOL})\n`);
  io.out(`next: give each agent its instructions, one per agent name:\n  collab-cue brief --as <name>\n`);
}

/** Bolded ids (`**R-3**`) that start a row or bullet in the ringer's own latest turn. Used only to
 *  warn: the gate's id set is the --expect input, never derived from the report (G-14). */
function boldedIds(text, as) {
  const lines = trailingRun(entries(text), (h) => isMine(h, as)).flatMap((e) => e.lines);
  const found = new Set();
  for (const line of lines) {
    const m = /^[\s>|-]*\*\*([A-Za-z]+-\d+)\*\*/.exec(line);
    if (m) found.add(m[1]);
  }
  return [...found];
}

function cmdRing({ root, report, as, kind = 'notes', note = '', expect, final }) {
  needAs(as);
  if (kind === 'human' && !note) die('--kind human needs --note: say in one line what you need from the human');
  const p = paths(root, report);
  const prev = readJson(p.cue, {});
  const { text, sha } = readReport(p);
  const cue = {
    protocol: PROTOCOL,
    seq: (prev.seq ?? 0) + 1, // a re-ring for the same bytes is still a new ring (F4)
    from: as,
    kind,
    note,
    sha,
    at: new Date().toISOString(),
    final: Boolean(final),
    expect: parseIds(expect),
  };
  const unlisted = boldedIds(text, as).filter((id) => !cue.expect.includes(id));
  if (unlisted.length) io.err(`collab-cue: warning: your latest entry has bolded id(s) not in --expect: ${unlisted.join(',')} (the counterpart will not be asked to answer them)\n`);
  writeJson(p.cue, cue);
  io.out(`rung by ${as} (${cue.expect.length} expected id(s)${cue.final ? ', final' : ''})\n`);
}

/** The cue as `as` sees it: rung when the counterpart rang and `as` has not acked that ring. */
function cueState(p, as) {
  const cue = readJson(p.cue);
  const ack = readJson(p.ack(as), { sha: null, seq: 0 });
  const unseen = cue && (cue.sha !== ack.sha || (cue.seq ?? 0) > (ack.seq ?? 0));
  return { cue, rung: Boolean(cue && cue.from && cue.from !== as && unseen) };
}

function cmdStatus({ root, report, as, json }) {
  needAs(as);
  const p = paths(root, report);
  const { cue, rung } = cueState(p, as);
  if (json) {
    io.out(JSON.stringify({ as, state: rung ? 'rung' : 'quiet', from: cue?.from ?? null, sha: cue?.sha ?? null, seq: cue?.seq ?? 0, expect: cue?.expect ?? [] }) + '\n');
  } else {
    io.out(`CUE as=${as} state=${rung ? 'rung' : 'quiet'} from=${cue?.from ?? '-'} expect=${(cue?.expect ?? []).join(',') || '-'}\n`);
  }
}

/** Block until the counterpart rings, or time out (exit 3). A convenience, never the mechanism:
 *  `status` answers whenever asked and cannot time out, so a dead waiter loses nothing. Does not
 *  ack; after your round, `ack` then `ring`. */
function cmdWait({ root, report, as, timeout = '3600', poll = '15' }) {
  needAs(as);
  const t = Number(timeout);
  const every = Number(poll);
  if (!Number.isFinite(t) || t < 0) die(`--timeout must be a number of seconds >= 0 (got '${timeout}')`);
  if (!Number.isFinite(every) || every <= 0) die(`--poll must be a number of seconds > 0 (got '${poll}')`);
  const p = paths(root, report);
  const deadline = Date.now() + t * 1000;
  for (;;) {
    const { cue, rung } = cueState(p, as);
    if (rung) {
      io.out(`CUE rung from=${cue.from} note=${JSON.stringify(cue.note ?? '')} sha=${cue.sha} seq=${cue.seq ?? 0} expect=${(cue.expect ?? []).join(',') || '-'}\n`);
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      io.out(`CUE timeout as=${as} after=${t}s\n`);
      throw new Exit(3);
    }
    sleep(Math.min(every * 1000, left));
  }
}

/** Everything the gate decides, as data: shared by `gate` (prints it) and `next` (acts on it). */
function gateState(p, as, ids) {
  const { text, sha } = readReport(p);
  const age = Math.round((Date.now() - fs.statSync(p.report).mtimeMs) / 1000);
  const state = readJson(p.state(as), { lastReviewedSha: null });
  const cue = readJson(p.cue, { expect: [] });
  const want = ids !== undefined ? parseIds(ids) : (cue.expect ?? []);
  // Whose answers are we waiting for? The ringer's, when the counterpart rang; else anyone but me.
  const writer = cue.from && cue.from !== as ? (h) => isMine(h, cue.from) : (h) => !isMine(h, as);
  const missing = missingAnswers(text, want, writer);
  const { heads } = scan(text);
  const heading = heads.length ? heads[heads.length - 1].text : null;
  const author = authorOf(heading, as);
  const hasEntries = heading !== null;
  const notMe = !isMine(heading, as);
  const fresh = sha !== state.lastReviewedSha;
  // A writer may retire its own settle window, for the exact bytes it rang for. A reader may not (F7).
  const finalByWriter = Boolean(cue.final) && cue.sha === sha && Boolean(cue.from) && isMine(heading, cue.from);
  const settled = finalByWriter || age >= SETTLE_SECONDS;
  const ready = fresh && settled && hasEntries && notMe && missing.length === 0;
  const reason = !fresh ? 'no-new-content' : !settled ? 'still-changing' : !hasEntries ? 'no-entries' : !notMe ? 'waiting-for-counterpart' : missing.length ? 'answers-incomplete' : 'ready';
  return { cue, age, author, fresh, settled, missing, ready, reason };
}

function cmdGate({ root, report, as, ids }) {
  needAs(as);
  const g = gateState(paths(root, report), as, ids);
  io.out(`STATE ready=${g.ready ? 'yes' : 'no'} new=${g.fresh ? 'yes' : 'no'} settled=${g.settled ? 'yes' : 'no'} age=${g.age}s lastAuthor=${g.author} reason=${g.reason} missing=${g.missing.length ? g.missing.join(',') : 'none'}\n`);
  throw new Exit(g.ready ? 0 : 1);
}

/** One line that says what to do this turn, so an agent needs no judgement to pick the next step. */
function cmdNext({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const say = (action, detail, advice) => io.out(`NEXT ${action}${detail ? ` ${detail}` : ''} - ${advice}\n`);
  if (isClosed(readReport(p).text)) {
    return say('closed', '', 'the collaboration is closed. Ask the human whether to continue with the remaining tasks; do not reopen on your own');
  }
  const { cue, rung } = cueState(p, as);
  const note = JSON.stringify(cue?.note ?? '');
  if (cue?.kind === 'human' && cue.from === as) return say('human', `note=${note}`, 'you asked the human for something. Stop until they reply, then ring normally');
  if (rung && cue.kind === 'human') return say('standby', `from=${cue.from} note=${note}`, `${cue.from} is waiting on the human. Do not start a round`);
  if (!rung) return say('wait', '', 'nothing is owed to the other agent. Stop, or run `wait` as a background job');
  const g = gateState(p, as);
  if (g.reason === 'still-changing') return say('settling', `age=${g.age}s`, 'the other agent may still be writing. Check again shortly; do not read it yet');
  if (g.reason === 'answers-incomplete') return say('answer', `from=${cue.from} missing=${g.missing.join(',')}`, 'answer only the missing ids in your next entry');
  if (g.ready) return say('round', `from=${cue.from} expect=${(cue.expect ?? []).join(',') || '-'}`, 'review the other agent\'s latest entry (`tail`), answer every id, then append, commit, ack, ring');
  return say('wait', `reason=${g.reason}`, 'nothing for you to review yet');
}

/** The instructions an agent needs, with its name filled in. Paste into that agent's prompt. */
function cmdBrief({ report, as }) {
  needAs(as);
  const file = path.basename(report ?? 'PROJECT_REPORT.md');
  const c = (cmd) => `collab-cue ${cmd} --as ${as}`;
  io.out([
    `You are "${as}" in a two-agent review with another agent. The shared file is ${file}.`,
    'Run these from the project root. Never edit the file by hand or touch the other agent\'s entries.',
    '',
    `Start every turn, and after every step, with:  ${c('next')}`,
    'It prints one line, NEXT <action>. Do what it says:',
    `  round     Read the other agent's latest entry (${c('tail')}). Answer every finding on`,
    '            its own line as ACCEPT, REBUT or DEFER, with evidence. Then, in order:',
    `              ${c('append')}   (entry on stdin; first line "### ${as} - title", "####" below it)`,
    `              ${c('commit')}   (prints the round number)`,
    `              ${c('ack')}`,
    `              collab-cue ring --as ${as} --expect <ids you answered> --final`,
    '  answer    As round, but answer only the missing ids it lists.',
    '  settling  The other agent is still writing. Re-check shortly; do not read yet.',
    `  wait      Nothing is owed. Stop, or run ${c('wait')} (exit 3 = timeout, then stop).`,
    '  standby   The other agent is waiting on the human. Do nothing.',
    '  human     You asked the human something. Stop until they reply.',
    '  closed    The collaboration is closed. Ask the human whether to continue with the',
    '            remaining tasks. Never reopen on your own.',
    '',
    'Work autonomously: do not ask the human whether to proceed with a round. Stop and ask the human only when you need one of:',
    '  - a decision only they can make, or a credential or secret;',
    '  - anything destructive or outward-facing (publishing, sending, deleting, spending);',
    '  - confirmation to continue, when you have no open findings left, or when the round',
    '    number printed by commit is a multiple of 5.',
    'To ask: run  collab-cue ring --as ' + as + ' --kind human --note "<one line: what you need>",',
    'tell the human the same line, and stop. Do not guess at the answer.',
    '',
  ].join('\n'));
}

function cmdAck({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const cue = readJson(p.cue, { sha: null, seq: 0 });
  writeJson(p.ack(as), { sha: cue.sha, seq: cue.seq ?? 0, at: new Date().toISOString() });
  io.out(`acked as ${as}\n`);
}

function cmdCommit({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const { sha } = readReport(p);
  const prev = readJson(p.state(as), { round: 0 });
  const round = (prev.round ?? 0) + 1;
  writeJson(p.state(as), { lastReviewedSha: sha, at: new Date().toISOString(), round });
  io.out(`committed ${as} round=${round}\n`);
}

/**
 * The only sanctioned way to add an entry (G-13). Rules, each of which was a real defect:
 *   no control bytes     -> an entry was corrupted with 0x08/0x09/0x0B
 *   heading names --as   -> authorship is read from the heading, so it must be yours (F2)
 *   one '###' at most    -> a later one breaks author detection (P-2); fenced ones are not headings
 *   always at EOF        -> a mid-file append inserted an entry above the counterpart's (Round 11)
 */
function cmdAppend({ root, report, as, file }) {
  needAs(as);
  const p = paths(root, report);
  let body;
  try { body = file !== undefined ? fs.readFileSync(file, 'utf8') : io.stdin(); }
  catch (e) { if (e instanceof Exit) throw e; die(`cannot read entry: ${e.message}`); }
  body = body.replace(/^\uFEFF/, '');
  const existing = readReport(p).text;

  // Allowed: TAB, LF, CR and printable text. Refused: NUL, 0x01-0x08, VT, FF, 0x0E-0x1F, DEL.
  const bad = [];
  body.split(/\r?\n/).forEach((l, n) => {
    for (const ch of l) {
      const c = ch.codePointAt(0);
      if (c < 9 || c === 11 || c === 12 || (c > 13 && c < 32) || c === 127) bad.push(`U+${c.toString(16).toUpperCase().padStart(4, '0')} on line ${n + 1}`);
    }
  });
  if (bad.length) refuse(`refusing to append: ${bad.length} ASCII control byte(s): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', ...' : ''}`);

  const { lines, heads } = scan(body);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) refuse('refusing to append: empty entry');
  const own = heads.find((h) => h.i === first);
  if (!own) refuse(`refusing to append: the entry must start with a '### ${as} ...' heading`);
  if (!isMine(own.text, as)) refuse(`refusing to append: heading '${own.text}' does not name --as ${as}`);
  const extra = heads.filter((h) => h.i !== first);
  if (extra.length) refuse(`refusing to append: ${extra.length} extra '###' heading(s) inside the entry; only the first line may be '###', use '####' below it (P-2)`);

  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const entry = body.startsWith('\n') ? body : `\n${body}`;
  fs.appendFileSync(p.report, sep + entry + (entry.endsWith('\n') ? '' : '\n'), 'utf8');
  io.out(`appended ${Buffer.byteLength(body, 'utf8')} bytes at EOF as ${as}\n`);
}

/** The counterpart's latest turn: every consecutive entry since your own last one (F11). */
function cmdTail({ root, report, as }) {
  needAs(as);
  const p = paths(root, report);
  const run = trailingRun(entries(readReport(p).text), (h) => !isMine(h, as));
  io.out(run.flatMap((e) => e.lines).join('\n'));
}

/** G-16: no --force. --open is mandatory, and the ringer's expected ids must be answered in its
 *  latest turn. Note the limit: the cue is self-authored, so `ring --expect ''` then `close` is
 *  possible; close proves the report is consistent with the cue, not that no finding exists. */
function cmdClose({ root, report, as, open }) {
  needAs(as);
  if (open === undefined) refuse('refusing to close: --open <n> is required (G-16)');
  if (!/^\d+$/.test(open)) refuse(`refusing to close: --open must be a non-negative integer (got '${open}')`);
  if (Number(open) > 0) refuse(`refusing to close: ${open} H/M finding(s) open (G-16)`);
  const p = paths(root, report);
  const cue = readJson(p.cue, { expect: [] });
  const { text } = readReport(p);
  if (isClosed(text)) refuse('refusing to close: already closed (append `## COLLAB REOPENED` first)');
  const missing = missingAnswers(text, cue.expect ?? [], cue.from ? (h) => isMine(h, cue.from) : () => true);
  if (missing.length) refuse(`refusing to close: expected id(s) not answered: ${missing.join(',')} (G-16)`);
  const block = ['', '## COLLAB CLOSED', '', `- Closed by: ${as}`, `- Open findings: ${open}`, `- At: ${new Date().toISOString()}`, ''].join('\n');
  fs.appendFileSync(p.report, block, 'utf8');
  io.out('closed\n');
}

/* ------------------------------------------------------------------ selftest */

/** Run the real CLI in-process and capture what it would have printed and exited with. */
function runCli(argv, { stdin = '' } = {}) {
  const saved = io;
  let out = '';
  let err = '';
  io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => stdin };
  let code = 0;
  try { dispatch(argv); }
  catch (x) {
    if (x instanceof Exit) code = x.code;
    else { err += `collab-cue: ${x.message}\n`; code = 2; }
  } finally { io = saved; }
  return { code, out, err };
}

function cmdSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cue-'));
  const cases = [];
  const t = (name, ok) => cases.push({ name, ok: Boolean(ok) });
  const run = (args, stdin) => runCli([...args, '--root', dir], { stdin });
  const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const cue = () => JSON.parse(rd('collab/cue.json'));
  const fresh = () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); run(['init']); };
  const app = (as, text) => run(['append', '--as', as], text);
  const gate = (as, ...more) => run(['gate', '--as', as, ...more]);
  const writer = (n) => (h) => isMine(h, n);

  try {
    /* answer detection (pure) */
    const doc = [
      '### Req — findings',
      '| **R-20** | H | Gate must not ACCEPT bad input | Fix it |',
      '### Resp — answers',
      '| R-1 | ACCEPT | ok |', '| **R-2** | REBUT | no |', '- R-3: DEFER', 'prose mentioning R-4 and ACCEPT',
      '| R-10 | ACCEPT | x |', '| R-6 | accept | x |', 'ACCEPT R-7',
    ].join('\n');
    const miss = (ids) => missingAnswers(doc, ids, writer('resp'));
    t('table, bold and bullet answers count', miss(['R-1', 'R-2', 'R-3']).length === 0);
    t('prose is not an answer', miss(['R-4']).length === 1);
    t('R-1 is not answered by R-10', missingAnswers('### Resp\n| R-10 | ACCEPT | x |', ['R-1'], writer('resp')).length === 1);
    t('lowercase verdict does not count', miss(['R-6']).length === 1);
    t('verdict before the id does not count', miss(['R-7']).length === 1);
    t('a finding row whose prose says ACCEPT is not its own answer (F9)', missingAnswers(doc, ['R-20'], writer('req')).length === 1);
    t('an answer in an older turn does not count (F9)', missingAnswers('### Resp - old\n| R-1 | ACCEPT | x |\n### Me - mid\nnothing\n### Resp - new\nnothing\n', ['R-1'], writer('resp')).length === 1);

    /* headings */
    t('DSH-2 and Correction (DSH) are DSH, DSHS is not (F3, F12)', isMine('DSH-2 - e', 'dsh') && isMine('Correction (DSH) — d', 'dsh') && isMine('DSH (Correction)', 'dsh') && !isMine('DSHS', 'dsh'));
    t('### inside a fence is not a heading (F10)', scan('### A\n```sh\n### c\n```\n~~~\n### d\n~~~\n### B\n').heads.length === 2);

    /* init / append */
    fresh();
    t('init is idempotent', run(['init']).code === 0 && cue().seq === 0);
    t('append accepts an entry with its own heading', app('dsh', '### DSH — round\n- R-1 ACCEPT\n#### sub\n').code === 0);
    t('append lands at EOF', rd('PROJECT_REPORT.md').endsWith('#### sub\n'));
    t('append refuses a second ### heading', app('dsh', '### DSH - A\nbody\n### B\n').code === 1);
    t('append refuses an unheaded entry (F2)', app('dsh', '| R-9 | DEFER |\n').code === 1);
    t('append refuses a heading naming someone else (F2)', app('dsh', '### Amy - forged\n').code === 1);
    t('append accepts a Correction heading', app('dsh', '### Correction (DSH) — fix\nx\n').code === 0);
    t('append accepts ### inside a fence (F10)', app('dsh', '### DSH - fenced\n```sh\n### comment\n```\n').code === 0);
    for (const [name, code] of [['NUL', 0], ['ESC', 27], ['VT', 11], ['DEL', 127]]) {
      t(`append refuses ${name}`, app('dsh', `### DSH - c
a${String.fromCharCode(code)}b
`).code === 1);
    }
    t('control-byte message names the code point', /U\+0000 on line 2/.test(app('dsh', '### DSH - c\na\u0000b\n').err));
    t('append refuses an empty entry', app('dsh', '\n \n').code === 1);
    t('append refuses a missing report (n3)', runCli(['append', '--as', 'dsh', '--root', path.join(dir, 'none')], { stdin: '### DSH - x\n' }).code === 2);

    /* flags (F1) */
    t('--as is required', run(['status']).code === 2);
    t('--as rejects path characters', run(['status', '--as', '../x']).code === 2);
    t('--ids=R-1 is parsed, not dropped', (() => { app('amy', '### Amy - q\n'); return /missing=R-1/.test(gate('dsh', '--ids=R-1').out); })());
    t('an unknown flag is an error', gate('dsh', '--id', 'R-1').code === 2);
    t('a value flag without a value is an error', run(['ring', '--as', 'dsh', '--expect']).code === 2);
    t('a stray positional is an error', run(['ring', '--as', 'dsh', 'R-1']).code === 2);
    t('bare --file is an error (n4)', run(['append', '--as', 'dsh', '--file']).code === 2);
    run(['ring', '--as', 'dsh', '--final', 'false']);
    t('--final false is false', cue().final === false);
    run(['ring', '--as', 'dsh', '--final']);
    t('bare --final is true', cue().final === true);
    run(['ring', '--as', 'dsh', '--expect=R-1,R-2']);
    t('ring --expect=R-1,R-2 is parsed', cue().expect.join() === 'R-1,R-2');
    t('status --json false prints text (F13)', /^CUE /.test(run(['status', '--as', 'amy', '--json', 'false']).out));
    t('status --json prints JSON', JSON.parse(run(['status', '--as', 'amy', '--json']).out).state === 'rung');

    /* cue: re-ring with the same bytes is seen (F4) */
    fresh();
    app('dsh', '### DSH - r\nx\n');
    run(['ring', '--as', 'dsh']);
    run(['ack', '--as', 'amy']);
    t('status is quiet after ack', /state=quiet/.test(run(['status', '--as', 'amy']).out));
    run(['ring', '--as', 'dsh', '--expect', 'R-1']);
    t('a re-ring for the same bytes is rung again (F4)', /state=rung .*expect=R-1/.test(run(['status', '--as', 'amy']).out));

    /* --as fallback, brief, init hint */
    fresh();
    t('init points at brief', /brief --as/.test(run(['init']).out));
    t('brief fills in the name and the loop', (() => { const r = run(['brief', '--as', 'dsh']); return r.code === 0 && /You are "dsh"/.test(r.out) && /collab-cue next --as dsh/.test(r.out) && /### dsh - title/.test(r.out) && /--kind human/.test(r.out); })());
    t('brief needs --as', run(['brief']).code === 2);
    process.env.COLLAB_AS = 'envy';
    t('COLLAB_AS is the default for --as', /as=envy/.test(run(['status']).out));
    t('--as beats COLLAB_AS', /as=amy/.test(run(['status', '--as', 'amy']).out));
    delete process.env.COLLAB_AS;

    /* next */
    fresh();
    const nx = (n) => run(['next', '--as', n]).out;
    t('next: wait when nothing rang', /^NEXT wait /.test(nx('amy')));
    app('dsh', '### DSH - r\n| R-1 | ACCEPT | a |\n');
    run(['ring', '--as', 'dsh', '--expect', 'R-1']);
    t('next: settling while the writer has not finished', /^NEXT settling /.test(nx('amy')));
    run(['ring', '--as', 'dsh', '--expect', 'R-1', '--final']);
    t('next: round when ready', /^NEXT round from=dsh expect=R-1 /.test(nx('amy')));
    run(['ring', '--as', 'dsh', '--expect', 'R-1,R-2', '--final']);
    t('next: answer lists only the missing ids', /^NEXT answer from=dsh missing=R-2 /.test(nx('amy')));
    t('ring --kind human needs --note', run(['ring', '--as', 'dsh', '--kind', 'human']).code === 2);
    run(['ring', '--as', 'dsh', '--kind', 'human', '--note', 'need the prod key']);
    t('next: the asker is told to stop', /^NEXT human note="need the prod key"/.test(nx('dsh')));
    t('next: the other agent stands by', /^NEXT standby from=dsh /.test(nx('amy')));
    run(['ring', '--as', 'dsh', '--expect', 'R-1', '--final']);
    run(['ack', '--as', 'amy']);
    t('next: wait after ack', /^NEXT wait /.test(nx('amy')));
    run(['ring', '--as', 'dsh', '--expect', 'R-1', '--final']);
    t('next: closed asks the human', (() => { run(['close', '--as', 'dsh', '--open', '0']); return /^NEXT closed /.test(nx('amy')) && /human/.test(nx('amy')); })());

    /* ring warns about bolded ids missing from --expect (G-14) */
    fresh();
    app('dsh', '### DSH - r\n| **R-1** | ACCEPT | a |\n| **R-2** | REBUT | b |\n- **P-3** DEFER\nprose about **R-9** here\n');
    t('ring warns about bolded ids not in --expect', (() => { const r = run(['ring', '--as', 'dsh', '--expect', 'R-1']); return r.code === 0 && /warning: .*R-2,P-3/.test(r.err) && !/R-9|R-1[^0-9]/.test(r.err.replace('--expect', '')); })());
    t('ring is silent when every bolded id is listed', (() => { const r = run(['ring', '--as', 'dsh', '--expect', 'R-1,R-2,P-3']); return r.code === 0 && r.err === ''; })());
    t('the warning never changes the cue', cue().expect.join() === 'R-1,R-2,P-3');
    t('ring warns when --expect is omitted', /R-1,R-2,P-3/.test(run(['ring', '--as', 'dsh']).err));
    app('amy', '### Amy - r\n| **R-7** | ACCEPT | a |\n');
    t('only the ringer\'s own latest turn is scanned', run(['ring', '--as', 'dsh', '--expect', 'R-1']).err === '');

    /* wait (exit 3) */
    fresh();
    app('dsh', '### DSH - r\nx\n');
    t('wait times out with exit 3 when nothing rings', (() => { const r = run(['wait', '--as', 'amy', '--timeout', '0.3', '--poll', '0.1']); return r.code === 3 && /CUE timeout/.test(r.out); })());
    run(['ring', '--as', 'dsh', '--note', 'R-1 answered', '--expect', 'R-1']);
    t('wait returns at once when already rung', (() => { const r = run(['wait', '--as', 'amy', '--timeout', '5']); return r.code === 0 && /CUE rung from=dsh note="R-1 answered"/.test(r.out) && /expect=R-1/.test(r.out); })());
    t('wait does not ack', /state=rung/.test(run(['status', '--as', 'amy']).out));
    run(['ack', '--as', 'amy']);
    t('wait times out again after ack', run(['wait', '--as', 'amy', '--timeout', '0', '--poll', '0.1']).code === 3);
    t('wait never rings for your own cue', run(['wait', '--as', 'dsh', '--timeout', '0']).code === 3);
    t('wait rejects a bad --timeout / --poll', run(['wait', '--as', 'amy', '--timeout', 'x']).code === 2 && run(['wait', '--as', 'amy', '--poll', '0']).code === 2);

    /* gate */
    fresh();
    const old = new Date(Date.now() - 400000);
    fs.utimesSync(path.join(dir, 'PROJECT_REPORT.md'), old, old);
    t('an empty report is not ready (F6)', /reason=no-entries/.test(gate('amy').out) && gate('amy').code === 1);
    app('dsh', '### DSH - r\n| R-5 | ACCEPT | ok |\n');
    run(['ring', '--as', 'dsh', '--final', '--expect', 'R-5']);
    t('the writer retires its settle window', /settled=yes .*reason=ready/.test(gate('amy').out) && gate('amy').code === 0);
    t('the writer is told to wait', /reason=waiting-for-counterpart/.test(gate('dsh').out));
    app('dsh', '### DSH-2 - more\n');
    t('final does not apply once the bytes changed', /settled=no/.test(gate('amy').out));
    run(['ring', '--as', 'amy', '--final']);
    t('a reader cannot retire the settle window (F7)', /settled=no/.test(gate('amy').out));
    run(['ring', '--as', 'dsh', '--final']);
    t('DSH-2 is read as DSH (F3)', /reason=waiting-for-counterpart/.test(gate('dsh').out));
    t('gate answers use the ringer\'s latest turn (F9)', (() => {
      fresh();
      app('dsh', '### DSH - old\n| R-1 | ACCEPT | x |\n');
      app('amy', '### Amy - ask\n| R-1 | H | please ACCEPT | y |\n');
      app('dsh', '### DSH - new\nnothing\n');
      run(['ring', '--as', 'dsh', '--final', '--expect', 'R-1']);
      return /missing=R-1/.test(gate('amy').out) && /reason=answers-incomplete/.test(gate('amy').out);
    })());
    t('gate exit codes: 1 blocked, 2 error', gate('amy').code === 1 && gate('amy', '--bogus').code === 2);

    /* tail (F11) */
    fresh();
    app('amy', '### Amy - mine\nM\n');
    app('zed', '### Zed - a\n1\n');
    app('zed', '### Correction (Zed) — b\n2\n');
    const tail = run(['tail', '--as', 'amy']).out;
    t('tail returns every consecutive counterpart entry (F11)', /Zed - a/.test(tail) && /Correction \(Zed\)/.test(tail) && !/Amy - mine/.test(tail));
    app('amy', '### Amy - reply\nR\n');
    t('tail is empty after your own entry', run(['tail', '--as', 'amy']).out === '');

    /* close */
    fresh();
    app('dsh', '### DSH - a\n');
    run(['ring', '--as', 'dsh', '--expect', 'R-5']);
    t('close needs --open', run(['close', '--as', 'dsh']).code === 1);
    t('close refuses --open > 0', run(['close', '--as', 'dsh', '--open', '2']).code === 1);
    t('close refuses unanswered expected ids', run(['close', '--as', 'dsh', '--open', '0']).code === 1);
    app('dsh', '### DSH - answers\n| R-5 | ACCEPT | ok |\n');
    t('close succeeds once answered', run(['close', '--as', 'dsh', '--open', '0']).code === 0 && /COLLAB CLOSED/.test(rd('PROJECT_REPORT.md')));
    t('close is not repeated (n2)', run(['close', '--as', 'dsh', '--open', '0']).code === 1 && rd('PROJECT_REPORT.md').split('## COLLAB CLOSED').length === 2);

    /* errors */
    t('a missing report is a clean error', (() => { const r = runCli(['ring', '--as', 'a', '--root', path.join(dir, 'none')]); return r.code === 2 && !/\n\s+at /.test(r.err); })());
    fs.writeFileSync(path.join(dir, 'collab/cue.json'), '{bad');
    t('a corrupt cue is an error, not quiet', run(['status', '--as', 'me']).code === 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) io.out(`SELFTEST ${c.ok ? 'PASS' : 'FAIL'} ${c.name}\n`);
  io.out(`SELFTEST RESULT ${failed.length ? `fail=${failed.length}` : `pass (${cases.length})`}\n`);
  throw new Exit(failed.length ? 1 : 0);
}

/* ------------------------------------------------------------------ main */

const USAGE = 'collab-cue <init|brief|ring|status|next|wait|gate|ack|commit|append|tail|close|selftest> [--root dir] [--report file] [--as agent] [--expect ids] [--final] [--json] [--file path] [--open n] [--ids ids] [--timeout s] [--poll s]\n';

function dispatch(argv) {
  const cmd = argv[0];
  if (!cmd) { io.out(USAGE); throw new Exit(0); }
  if (!Object.hasOwn(CMDS, cmd)) { io.out(USAGE); throw new Exit(1); }
  const f = parseFlags(cmd, argv.slice(1));
  const a = { root: f.root ?? process.cwd(), report: f.report, as: f.as || process.env.COLLAB_AS || undefined };
  switch (cmd) {
    case 'init': return cmdInit(a);
    case 'ring': return cmdRing({ ...a, kind: f.kind, note: f.note, expect: f.expect, final: f.final });
    case 'status': return cmdStatus({ ...a, json: f.json });
    case 'next': return cmdNext(a);
    case 'brief': return cmdBrief(a);
    case 'wait': return cmdWait({ ...a, timeout: f.timeout, poll: f.poll });
    case 'gate': return cmdGate({ ...a, ids: f.ids });
    case 'ack': return cmdAck(a);
    case 'commit': return cmdCommit(a);
    case 'append': return cmdAppend({ ...a, file: f.file });
    case 'tail': return cmdTail(a);
    case 'close': return cmdClose({ ...a, open: f.open });
    case 'selftest': return cmdSelftest();
  }
}

try {
  dispatch(process.argv.slice(2));
} catch (x) {
  if (x instanceof Exit) process.exitCode = x.code;
  else { process.stderr.write(`collab-cue: ${x.message}\n`); process.exitCode = 2; }
}

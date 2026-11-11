# Review — PR #1 `fix/review-findings` → `master`

**Repo:** retro1878/collab-cue · **Head:** `595f65ed0efab0675282d675c056ceae18bc2357` · **Base:** `1993bc27b277050f55c99715f5193dd6f6d7ae7a`
**Scope:** 3 files, +264/−107 (`bin/collab-cue.mjs` +220/−98, `README.md`, `LICENSE` new)
**Reviewed:** head and base blobs pulled independently, selftest and CLI probes run against both.
**Status:** open — none of the findings below has been answered or rebutted yet.

## Verdict

**Request changes.** The PR is honest and substantial: every defect it claims to fix reproduces on
base and is genuinely fixed on head, and the selftest really does drive the CLI (28/28 pass). But two
guard holes remain and they are in the gate itself, which is the one component whose whole job is to
be un-bluffable. F1 and F2 should block; F3–F4 are cheap and belong in this PR; F5–F7 are follow-ups.

| # | Severity | Finding | Line @ `595f65e` |
| :-- | :-- | :-- | :-- |
| F1 | **High** | Unknown / `--key=value` flags are silently dropped — `gate --ids=R-1` reports `ready=yes` with the answer check disabled | `bin/collab-cue.mjs:32-44`, `:187` |
| F2 | **High** | `append` never requires an entry heading, and never checks it names `--as`; authorship is then inferred from the last heading anywhere | `:242-246`, `:104-121`, `:189-191` |
| F3 | Medium | Any hyphenated variant of your own name (`### DSH-2`) is read as the counterpart → you gate `ready` on your own bytes | `:114-115` |
| F4 | Medium | Re-ringing the same bytes with new `--expect` is invisible: `status` stays `quiet` | `:172`, `:206` |
| F5 | Low | `close` is still bypassable with one extra command (`ring --expect ''` then `close --open 0`); `--open` is self-reported | `:269-277` |
| F6 | Low | `gate` returns `ready=yes` on a report with no entries at all (`lastAuthor=unknown`) | `:191`, `:196` |
| F7 | Low | The *reviewer* can retire the writer's settle window by ringing `--final` | `:193-195` |
| F8 | Low / env | `selftest` cannot run inside a confined agent sandbox (piped stdio → `EPERM`) | `:299-302` |
| n1–n4 | Nit | control-byte message hardcodes `(R-41)`; `close` not idempotent; `append` silently creates a missing report; bare `--file` reads stdin | `:240`, `:278-287`, `:248` |
| F9 | **High** | `missingAnswers` scans the entire report instead of the counterpart's latest entry — old answers or finding definitions mentioning `ACCEPT`/`REBUT`/`DEFER` silently satisfy new `--expect` | `:128-134`, `:188`, `:276` |
| F10 | **High** | `append` scans every line for `/^###\s/` without ignoring fenced code blocks (` ``` ` / `~~~`) — markdown examples or shell comments (`###`) cause valid entries to be refused | `:243-246`, `:104-111`, `:258-263` |
| F11 | Medium | `tail` slices from the last non-`as` heading (`if (m && !isMine) start = i`), dropping earlier entries when the counterpart writes ≥2 consecutive entries (e.g., entry + `### Correction (DSH)`) | `:255-265` |
| F12 | Medium | F3's proposed `firstToken` fix breaks `HOOK.md §2.3` correction blocks (`### Correction (DSH) — ...`), where the first token is `correction`, not the agent name | `:114-121`, `REVIEW-PR1.md:105-108` |
| F13 | Low | `status` checks `if (json)` directly instead of `flag(json)`, so `--json false` or `--json 0` still outputs JSON; `writeJson` uses a shared `pid` temp path | `:173`, `:82` |

## What I verified as fixed `[E-1]`

Ran base and head side by side in temp roots. Each row is an observed behaviour, not a changelog claim.

| Claim | Base | Head |
| :-- | :-- | :-- |
| well-formed entry with its own `###` heading | refused `exit=1` | accepted |
| NUL in entry | **appended** `exit=0` | refused |
| `close` without `--open` | **closed** `exit=0` | refused |
| `ring --final false` | `"final": true` | `"final": false` |
| settle window | 1 s | 180 s (≥120 s protocol minimum ✓) |
| `R-1` answered by `R-10` | counted as answered | `missing=R-1` ✓ |
| corrupt `cue.json` | read as quiet | hard error, no stack trace ✓ |
| `selftest` 28 cases | re-tested copied logic | drives the real CLI, **28/28 PASS** ✓ |
| line endings | — | 0 CRLF in head blob; shebang survives ✓ |
| `LICENSE` | — | MIT, matches `package.json` `"license": "MIT"` ✓ |

## Findings

### F1 — Unknown and `=`-form flags are silently ignored, and `gate` fails open `[E-2]`

`flags()` (`:32-44`) takes everything after `--` as a key and never splits on `=`, and no command
validates its key set. So a dropped value is indistinguishable from an absent flag.

```
gate --as amy --ids R-1    → STATE ready=no  ... reason=answers-incomplete missing=R-1
gate --as amy --ids=R-1    → STATE ready=yes ... reason=ready                missing=none
gate --as amy --id R-1     → STATE ready=yes ... reason=ready                missing=none   (typo)
ring --as dsh --expect=R-1 → rung by dsh (0 expected id(s))                                 (silently empty)
```

The second and third lines are the failure that matters: the answer check is the gate's only
content check, and an ordinary POSIX spelling silently disables it *and* turns the verdict green.
`ring --expect=R-1` is quieter still — it prints `0 expected id(s)` but rings a cue that asks nothing,
so the counterpart's review is never requested.

**Fix (one place).** In `flags()`, split the key: `const [key, ...rest] = a.slice(2).split('=')` and
use `rest.join('=')` when non-empty. Then pass an allowlist per command and `die()` on anything else,
so `--id`/`--ids=` are loud instead of load-bearing. Kills the whole class, including `--json=1`.

### F2 — `append` doesn't enforce the heading rule it documents, so authorship is spoofable `[E-3]`

`:242-246` only refuses a *second* `###`. An entry with no heading at all, or with a heading that
names somebody else, is accepted. `lastHeading()` (`:104`) then attributes it to whatever heading
appeared last in the file — including one written turns ago by the counterpart.

```
append --as amy '### Amy - round 1'          # amy's real entry
append --as zed '| R-9 | DEFER | zed here |' # zed, no heading
ring --as zed --final
gate --as amy → STATE ready=no new=yes settled=yes lastAuthor=amy reason=waiting-for-counterpart
gate --as zed → STATE ready=yes ...                                          reason=ready
```

Zed's new content lands in the file of record and the counterpart is affirmatively told *not* to look
at it. Same result with a forged heading (`append --as zed '### Amy - forged'`): amy is blocked,
zed reviews its own text. The `--as`-based detection added in this PR is the right idea, but it is
only consulted, never enforced at write time.

**Fix.** In `cmdAppend`, require `first` to exist and match `/^###\s/`, and require
`isMine(lines[first], as)` before writing; otherwise `die("entry must start with '### <your --as> name'")`.
In `cmdGate`, derive the author from the entry block containing the last non-empty line rather than
the last heading anywhere. Note `README.md` already states this rule — it is the code that lags.

### F3 — Hyphen is inside the word class, so `name-2` reads as "not me" `[E-4]`

`isMine` (`:114-115`) requires `($|[^\w-])` after the name, and `-` is in that class. Anything
suffixed — a round number, a model tag, `### DSH-2` — fails the test, and `authorOf` then returns
`dsh-2`:

```
append --as dsh '### DSH-2 - entry'
ring --as dsh --final
gate --as dsh → STATE ready=yes new=yes settled=yes lastAuthor=dsh-2 reason=ready
```

Dsh gates `ready` on its own last entry. Boring headings (`### DSH - round 12`) are fine; anything
that glues the name to a suffix is not, which makes this a matter of when, not if.

**Fix.** Compare the heading's first token instead of running a boundary regex:
`const firstToken = (h) => (h.match(/[\w]+/) ?? [''])[0].toLowerCase()`, then `isMine = firstToken(h) === as.toLowerCase()`.
`DSH-2` → `dsh` ✓, `DSHS` → `dshs` ✓, `Amy-2` → `amy` ✓, and `authorOf` becomes the same value, so
`lastAuthor=` stops disagreeing with `notMe`.

### F4 — A re-ring with new ids never reaches the counterpart `[E-5]`

`status` (`:172`) considers only `cue.sha !== ack.sha`. Ringing again for the *same* bytes is the
documented way to say "I have not answered your ids yet" — the protocol's own `answers-incomplete`
path — but the bytes don't change, so the counterpart sleeps:

```
dsh: append → ring (sha S)
amy: status → state=rung ; ack
dsh: ring --expect R-1,R-2      (same sha S, asking for answers)
amy: status → CUE as=amy state=quiet from=dsh expect=R-1,R-2
```

`expect` is visibly non-empty and `state=quiet` at the same time — the two halves of the line contradict
each other.

**Fix.** Add a monotone `seq` to `cue.json` (or compare the `at`/`expect` tuple) and treat
`cue.seq > ack.seq` as rung. One integer, and it also makes the doorbell robust to a ring that only
changes `note`.

### F5 — `close` still cannot tell "nothing open" from "I said nothing is open" `[E-6]`

`:271-277` correctly refuses a missing `--open` or a non-zero one, and checks the cue's expected ids.
But the cue is writable by the closer, so the check is one command deep:

```
ring --as amy --expect R-1 ; close --as amy --open 0   → refusing to close: expected id(s) not answered: R-1 ✓
ring --as amy --expect ''  ; close --as amy --open 0   → closed ✓
```

The PR body's "close could be bypassed by omitting `--open`" is accurate as written, but `--open` is a
self-report and there is no `--force` only in the sense that there is a `ring` instead. Either say so
in `README.md`, or make `close` check something the closer cannot author: the cue's `expect` must be
non-empty *or* the last entry must be the counterpart's and answered, and the cue must be newer than
the last report write.

### F6 — `notMe` defaults to true when there is no author `[E-7]`

`:191` is `!isMine(null, as) === true`, so a report with zero entries is "written by somebody else":

```
init ; (age report 400 s) ; gate --as amy
→ STATE ready=yes new=yes settled=yes age=400s lastAuthor=unknown reason=ready
```

No content exists to review. Harmless in practice but it is a false `ready`, and this protocol exists
to remove false `ready`s. Treat unknown authorship as `waiting-for-counterpart` (or add a
`no-entries` reason).

### F7 — The settle window protects the reader, and the reader can switch it off `[E-8]`

`finalForThis` (`:194`) honours `cue.final` for any cue, not just the writer's. The settle window exists
so a reader never opens a half-written file; the reader can retire it:

```
append --as dsh (half an entry) ; gate --as amy → settled=no reason=still-changing
ring --as amy --final            ; gate --as amy → settled=yes reason=ready
```

**Fix.** Honour `final` only when `cue.from` is the last author (the writer retiring its own window),
or only when `cue.from !== as`.

### F8 — `selftest` is unrunnable in the sandboxes this tool targets `[E-9]`

`:299-302` spawns children with piped stdio. Under the file sandbox used by this harness, that is
denied (`spawnSync` → `EPERM`, `status: null`), and the selftest dies with an uncaught `ENOENT` on
`PROJECT_REPORT.md` rather than a readable "cannot spawn children here". Running unconfined, all 28
cases pass. Since the tool's users are agents in exactly such sandboxes, either document the
requirement in `README.md` ("selftest needs an unsandboxed shell") or catch `r.error?.code === 'EPERM'`
and emit one clear line instead of a stack trace.

## Nits

- `:240` always says `(R-41)`; ESC/DEL now land on a bug id that isn't theirs. Print the offending
  code points instead.
- `:287` — `close` twice appends two `## COLLAB CLOSED` blocks (verified). Refuse if the tail already
  contains one.
- `:248` — `append` silently creates a missing report while every other command says
  "not found (run `collab-cue init`)". Pick one.
- `:230` — bare `--file` falls back to stdin, so `append --file=x` (the `=` form) reads stdin and can
  block on a tty. Same root cause as F1; the F1 fix removes it.
- `bin/collab-cue.mjs` is mode `100644`. Fine for npm's shim; worth a thought if anyone runs
  `./bin/collab-cue.mjs` directly on Linux.

## Already-triaged, agreed

The PR's "Not done" list is honest and I agree with the deferral: a `wait` command and a distinct exit
code for "not ready" vs "error" (today both are 1, so `gate || die` cannot tell them apart). That is the
highest-value follow-up after F1/F2 — it is what lets a caller use the gate in a shell without parsing
stdout.

## Recommendation

1. **Block on F1 and F2.** Both are silent, both are reachable without malice, and both defeat the one
   guarantee the tool advertises.
2. Fold in **F3 and F4** — a first-token comparison and one `seq` field.
3. **F5–F7** may land as a documented limitation, but `README.md` should stop implying the close check
   is enforced rather than self-reported.
4. Re-run `selftest` unconfined after each change (F8) and add the flagged cases: `--ids=R-1`,
   unheadered entry, `### <name>-2`, re-ring same sha, empty report.

---

## Verification register

Every evidence tag in this document points at a command that was run, not at a reading of the code.

| Tag | Claim | How it was established | Observed |
| :-- | :-- | :-- | :-- |
| E-1 | the fixes are real | base and head CLI, same temp root, same inputs | base appended NUL / closed without `--open` / wrote `final: true`; head refused each |
| E-1 | the selftest is real | `node bin/collab-cue.mjs selftest` unconfined | `SELFTEST RESULT pass`, 28 `PASS` lines |
| E-1 | LF preserved | base64 blob `66e7dcb` decoded, byte count | 17698 bytes, 392 LF, 0 CRLF, shebang `23 21 2f…` |
| E-2 | F1 | `gate --ids=R-1`, `gate --ids R-1`, `gate --id R-1`, `ring --expect=R-1` | only the space form applied the ids; the others reported `ready=yes` / `0 expected id(s)` |
| E-3 | F2 | append as `amy`, then unheadered append as `zed`, `ring --as zed --final`, gate both | `gate --as amy` → `waiting-for-counterpart`; `gate --as zed` → `ready=yes` |
| E-4 | F3 | append `### DSH-2 - entry` as `dsh`, `ring --as dsh --final`, `gate --as dsh` | `ready=yes lastAuthor=dsh-2` |
| E-5 | F4 | `ring` sha S → `status`/`ack` → `ring --expect R-1,R-2` same bytes → `status` | `state=rung` then `state=quiet` with `expect=R-1,R-2` |
| E-6 | F5 | `ring --expect R-1` + `close --open 0`, then `ring --expect ''` + `close --open 0` | refused `exit=1`, then `closed` `exit=0` |
| E-7 | F6 | `init`, backdate report 400 s, `gate --as amy` | `ready=yes lastAuthor=unknown` |
| E-8 | F7 | append half an entry as `dsh`, `gate --as amy`, `ring --as amy --final`, `gate --as amy` | `still-changing` → `ready` at age 3 s |
| E-9 | F8 | `spawnSync` with default stdio under the file sandbox | `{"status":null,"error":"EPERM"}`; selftest died on uncaught `ENOENT` |
| E-10 | F9 | `append` finding row `\| **R-20** \| H \| Gate must not ACCEPT bad input \| Fix it \|` as `dsh`, then `append` entry without answering `R-20` as `antigravity`, `gate --as dsh --ids R-20` | `STATE ready=yes ... missing=none` (`exit=0`) |
| E-11 | F10 | `append --as dsh` with `### DSH - round 1` + fenced ```` ```sh \n ### comment in bash \n ``` ```` | `refusing to append: 1 extra '###' heading(s) inside the entry` (`exit=1`) |
| E-12 | F11 | `append` two consecutive entries as `zed` (`round 1` and `round 2`), then `tail --as dsh` | printed only `### Zed - round 2`, dropping `round 1` |
| E-13 | F12 | `append --as dsh '### Correction (DSH) — 2026-11-11'`, then `gate --as antigravity` | `lastAuthor=correction`; under F3's `firstToken(h) === as`, `isMine` would also become `false` for `dsh` |
| E-14 | F13 | `status --as dsh --json false` | printed JSON `{"as":"dsh","state":"rung",...}` instead of text line |

Environment: Windows, Node v26.7.0, PowerShell 7. Temp roots are discarded per probe; no probe wrote
outside its own `--root` except the read-only downloads of the base and head blobs.

The `bin/collab-cue.mjs` line numbers above are from the PR head (`595f65e`), not from `master`.

---

## Addendum — Deep-Dive Review (Antigravity)

Reviewed the full repository history (`3240b92` → `1993bc2`, PR #1 `9e4370a` → `595f65e`, and `review/pr1` `377b7f7`) alongside the origin session in `termix-reverse-ssh` (`PROJECT_REPORT.md` Rounds 1–19, `collab/HOOK.md`, `collab/LESSONS.md`, `collab/check_state.ps1`, `collab/cue.ps1`).

### Summary of Additional Findings (F9–F13)

#### F9 (High) — `missingAnswers` scans the entire historical report instead of the counterpart's latest turn (`[E-10]`)

`missingAnswers(text, want)` (`:128-134`, called at `:188` and `:276`) splits the entire `PROJECT_REPORT.md` from line 1 and checks whether *any* line in the file starts with `<id>` and contains `ACCEPT|REBUT|DEFER` after it. This breaks the gate in two ways:
1. **Self-answering finding definitions:** In `PROJECT_REPORT.md`, findings are introduced in Markdown tables (`| **R-20** | H | ... | ... |`). If the finding description or required action column mentions `ACCEPT`, `REBUT`, or `DEFER` in upper case (for example, `| **R-20** | H | Gate must not ACCEPT bad input | Fix it |`, which actually happened in `L-02` of the origin session!), `trimStart(line)` starts with `R-20` and `VERDICT.test(line.slice(id.length))` is `true`. The finding is marked as answered by the very table row that raised it, before the counterpart writes a single word (`[E-10]`).
2. **Re-opened or previously deferred IDs:** If `R-10` was answered with `DEFER` in Round 1 and re-expected in Round 5 (`ring --expect R-10`), the Round 1 row permanently satisfies `missingAnswers` for the rest of the file's life.

**Fix:** Scope `missingAnswers` to the counterpart's entries written *after* the requester's last `###` entry (or after the byte offset / entry corresponding to `state.<as>.lastReviewedSha`). Additionally, in table rows (`| ID | col2 | ...`), require the verdict token to be the **second cell** (`^\|\s*\*?\*?ID\*?\*?\s*\|\s*(ACCEPT|REBUT|DEFER)\b`) rather than matching anywhere in the row's prose.

#### F10 (High) — `append`, `lastHeading`, and `tail` do not ignore fenced code blocks (`[E-11]`)

In `cmdAppend` (`:243-246`), `lastHeading` (`:104-111`), and `cmdTail` (`:258-263`), every line matching `/^###\s/` is treated as an entry heading. Markdown fenced code blocks (` ``` ` or `~~~`) are not tracked.
- In `PROJECT_REPORT.md` (lines 231, 395), entries routinely include fenced Markdown templates (`### <Your agent name> — ...`) or shell/Python snippets with `###` comments.
- Passing such an entry to `collab-cue append` fails with `refusing to append: 1 extra '###' heading(s) inside the entry` (`[E-11]`).
- Worse, if a report already contains a fenced `###` block, `lastHeading` and `tail` misidentify it as an entry header.

**Fix:** Use a 6-line helper to strip or skip lines inside fenced code blocks (`/^(```|~~~)/`) when scanning for `### ` headings in `append`, `lastHeading`, and `tail`.

#### F11 (Medium) — `tail` drops earlier entries when the counterpart writes more than one entry in a row (`[E-12]`)

`README.md` (`:15`) documents `tail` as: *"everything since the counterpart's last entry"*, and the `G-13` design spec (`PROJECT_REPORT.md:1802`) defined `tail` as: *"prints only entries since `lastReviewedSha`"*.
However, `cmdTail` (`:259-263`) does:
```js
let start = 0;
lines.forEach((line, i) => {
  const m = /^###\s+(.+)$/.exec(line);
  if (m && !isMine(m[1], as)) start = i;
});
```
Because `start` is overwritten on *every* heading that is not `as`:
1. In `PROJECT_REPORT.md`, DSH frequently appended a main entry followed immediately by `### Correction (DSH)` (lines 521, 574, 774) or two consecutive entries (lines 588 & 613, 1298 & 1323, 1704 & 1727 & 1748). Running `tail --as antigravity` overwrites `start` at the last one and **drops all preceding unread entries from the counterpart** (`[E-12]`).
2. Conversely, if `as` has already replied at the bottom of the file, `tail --as me` still prints the counterpart's old entry AND `me`'s own latest entry after it.

**Fix:** Slice from the first non-`as` entry *after* the last `as` entry (or, if `state.<as>.json` exists, from the first entry after `lastReviewedSha`).

#### F12 (Medium) — F3's proposed `firstToken` fix breaks `HOOK.md` correction headings (`[E-13]`)

`HOOK.md §2.3` and `check_state.ps1:96` (`author-correction-block`) explicitly mandate `### Correction (DSH) — YYYY-MM-DD` for corrections.
- On PR #1 head, `isMine("Correction (DSH) — ...", "dsh")` is `true` (because `DSH` appears inside parens), while `authorOf` (`:120`) returns `correction` when queried by `antigravity` (`[E-13]`).
- If F3's recommendation (`firstToken(h) === as.toLowerCase()`) is applied verbatim, `firstToken("Correction (DSH)...")` is `"correction"`, which breaks `isMine` for `### Correction (<agent>)` blocks—regressing the `check_state.ps1:96` selftest fixture (`L-11`).

**Fix for both F3 and F12:** Strip a leading `Correction\s*` prefix (or parenthesized tag) before extracting the agent token, or require `cmdAppend` to format headings canonically as `### <as> — ...` (and `### <as> (Correction) — ...`) so the agent identifier is always the first token `[A-Za-z0-9_-]+` after `### `.

#### F13 (Low) — `status --json false` outputs JSON, and `writeJson` temp path is shared per PID (`[E-14]`)

1. PR #1 added `const flag = (v) => ...` (`:47`) to fix `--final false`, and applied it in `cmdRing` (`:160`), but forgot to apply it in `cmdStatus` (`:173`), which still tests `if (json)` directly. Thus `collab-cue status --as dsh --json false` outputs JSON (`[E-14]`).
2. `writeJson` (`:82`) writes to `${file}.${process.pid}.tmp` and `fs.renameSync`s it. That is atomic on POSIX and on Node/Windows `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, though Windows AV/indexers holding a brief read handle on `cue.json` can transiently fail `renameSync` with `EPERM`/`EACCES` (which is why `cue.ps1:31` had a 5-try retry loop).

### Assessment of F8 (Sandbox `spawnSync` `EPERM`)

In the Antigravity harness on this machine, `node bin/collab-cue.mjs selftest` runs and passes all 28 cases (`SELFTEST RESULT pass`), whereas in the Claude Code confined sandbox (`_pr-review/probe-spawn.mjs`) child process creation with piped stdio is blocked with `EPERM`. Adding an in-process dispatch fallback when `spawnSync` returns `r.error?.code === 'EPERM'` (or refactoring `main` into a callable `runCli(argv, stdin)` function) would make `selftest` work in **both** sandboxes with zero child-process overhead and ~10× faster execution.


# collab-cue

A cue-based review protocol for two agents sharing one file. Zero dependencies, Node 20+.

The protocol is the file layout; this CLI is a convenience over it, so an agent with no shared
tooling can still participate by reading `collab/cue.json`.

```
collab-cue init       create collab/ and the report stub
collab-cue brief      --as me   print the instructions to paste into that agent's prompt
collab-cue next       --as me   one line: what to do this turn (round, answer, wait, human, closed ...)
collab-cue watch      --as me --exec "<agent command>"   keep that agent turning on its own
collab-cue ring       --as me --expect R-1,R-2 [--final]
                      warns on stderr if your latest entry bolds ids (`**R-3**`) that --expect omits
collab-cue status     --as me [--json]   do I owe a round? (run this every turn)
collab-cue wait       --as me [--timeout 3600] [--poll 15]   block until the other side rings; exit 3 on timeout
collab-cue gate       --as me [--ids R-1,P-2]   is it reviewable? exit 0 = ready
collab-cue ack        --as me      I consumed the cue
collab-cue append     --as me      append an entry at EOF (stdin or --file)
collab-cue tail       --as me      everything since the counterpart's last entry
collab-cue commit     --as me      record the reviewed hash
collab-cue close      --as me --open 0   refuses unless --open is 0 and the ringer's expected ids are answered
collab-cue selftest   drives the real commands in-process in a temp dir (needs no child processes)
```

Install: `npm i -g collab-cue`, or run without installing: `npx collab-cue <command>`. From a
clone, `node bin/collab-cue.mjs <command>` works too. `--root <dir>` and `--report <file>` (default
`PROJECT_REPORT.md`) pick the project.

## Setting up two agents

```
collab-cue init
collab-cue brief --as alice      paste the output into alice's instructions
collab-cue brief --as bob        and this into bob's
```

Each agent then runs `collab-cue next --as <name>` at the start of every turn and does what the
line says. They work on their own, and stop to ask the human only for a decision, a secret,
anything destructive or outward-facing, or confirmation to continue (when nothing is left open, or
every fifth round). To ask, an agent runs `ring --kind human --note "<what it needs>"`; the other
agent's `next` then says `standby`. When the collaboration is closed, `next` says `closed` and the
agent asks the human whether to continue; reopening is the human's call.

Agents cannot wake themselves: something has to start each turn. Either use a background
`collab-cue wait` where the agent's harness wakes on a finished background command, or run a
watcher per agent:

```
collab-cue watch --as alice --exec 'claude -p "Run collab-cue next --as alice and do what it says"'
```

`watch` waits for the other side to ring, runs `--exec` (from the project root, with `COLLAB_AS` and
`COLLAB_NEXT` set) whenever a round or answer is owed, then waits again. It stops, leaving the
restart to you, when the agent asks the human or the collaboration closes (exit 0), when a run makes
no progress or `--max-runs` (default 10) is reached (exit 1), when `--exec` fails (exit 2), or on
`--timeout` (default 3600 s, exit 3). Give the `--exec` command the same permissions you would give
that agent in a normal session, and no more. Run one watcher per agent name.

`--as` can also come from the `COLLAB_AS` environment variable. It is not stored in `collab/`,
because both agents share that folder.

`--as` is any name matching `[A-Za-z0-9_-]+`. An entry's author is read from its heading, so
`append` requires the entry to start with `### <your --as name> ...` (`DSH-2` and
`Correction (DSH)` both read as `dsh`). Pick names that are not prefixes of one another.

Flags are strict: an unknown flag, a missing value or a stray argument is an error, and `--key=value`
works. Exit codes: `0` ok, `1` blocked (gate not ready, a guard refused), `2` error, `3` `wait` timed out.

`gate` waits for answers to the ids the cue expects, and only counts them in the ringer's latest
turn (the consecutive entries since the other side last wrote). A table row answers when its first
cell is the id and its second cell starts with `ACCEPT`, `REBUT` or `DEFER`. Only the writer can
retire the settle window (`ring --final`), and only for the bytes it rang for. Re-ringing the same
bytes bumps `seq`, so the other side sees it.

`close` checks the report against the cue; the cue is self-authored, so it proves consistency, not
that no finding exists.

## Why it exists

Built from a collaboration that lost two rounds to the same three defects: an entry inserted
mid-file, an entry corrupted by ASCII control bytes, and a gate whose strictness depended on prose
formatting. `append` refuses the first two by construction; `--expect` makes the gate's id set an
input rather than a guess.

A background waiter (`wait`) is an accelerator, never the mechanism. `status` is the mechanism: it answers
whenever asked, and it cannot time out.

## Append rules

An entry's own heading is its first line (`### Name — title`); every other heading inside it must be
`####` or deeper. ASCII control bytes (including NUL, VT, FF and DEL) are refused. Entries always
go at EOF.

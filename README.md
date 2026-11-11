# collab-cue

A cue-based review protocol for two agents sharing one file. Zero dependencies, Node 20+.

The protocol is the file layout; this CLI is a convenience over it, so an agent with no shared
tooling can still participate by reading `collab/cue.json`.

```
collab-cue init       create collab/ and the report stub
collab-cue ring       --as me --expect R-1,R-2 [--final]
collab-cue status     --as me [--json]   do I owe a round? (run this every turn)
collab-cue gate       --as me [--ids R-1,P-2]   is it reviewable? exit 0 = ready
collab-cue ack        --as me      I consumed the cue
collab-cue append     --as me      append an entry at EOF (stdin or --file)
collab-cue tail       --as me      everything since the counterpart's last entry
collab-cue commit     --as me      record the reviewed hash
collab-cue close      --as me --open 0   refuses unless --open is 0 and the ringer's expected ids are answered
collab-cue selftest   drives the real commands in-process in a temp dir (needs no child processes)
```

Not published to npm. Run it straight from git (`npx github:retro1878/collab-cue <command>`) or
`node bin/collab-cue.mjs <command>`. `--root <dir>` and `--report <file>` (default
`PROJECT_REPORT.md`) pick the project.

`--as` is any name matching `[A-Za-z0-9_-]+`. An entry's author is read from its heading, so
`append` requires the entry to start with `### <your --as name> ...` (`DSH-2` and
`Correction (DSH)` both read as `dsh`). Pick names that are not prefixes of one another.

Flags are strict: an unknown flag, a missing value or a stray argument is an error, and `--key=value`
works. Exit codes: `0` ok, `1` blocked (gate not ready, a guard refused), `2` error.

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

A background waiter is an accelerator, never the mechanism. `status` is the mechanism: it answers
whenever asked, and it cannot time out.

## Append rules

An entry's own heading is its first line (`### Name — title`); every other heading inside it must be
`####` or deeper. ASCII control bytes (including NUL, VT, FF and DEL) are refused. Entries always
go at EOF.

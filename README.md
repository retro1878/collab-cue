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
collab-cue close      --as me --open 0   refuses unless --open is 0 and every expected id is answered
collab-cue selftest   drives the real commands in a temp dir
```

Not published to npm. Run it straight from git (`npx github:retro1878/collab-cue <command>`) or
`node bin/collab-cue.mjs <command>`. `--root <dir>` and `--report <file>` (default
`PROJECT_REPORT.md`) pick the project.

`--as` is any name matching `[A-Za-z0-9_-]+`. An entry's author is read from its `### <name> ...`
heading, so use your `--as` name in it.

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

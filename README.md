# collab-cue

A cue-based review protocol for two agents sharing one file. Zero dependencies, Node 20+.

The protocol is the file layout; this CLI is a convenience over it, so an agent with no shared
tooling can still participate by reading `collab/cue.json`.

```
npx collab-cue init       create collab/ and the report stub
npx collab-cue ring       --as me --expect R-1,R-2 --final
npx collab-cue status     --as me      do I owe a round? (run this every turn)
npx collab-cue gate       --as me      is it reviewable? exit 0 = ready
npx collab-cue ack        --as me      I consumed the cue
npx collab-cue append     --as me      append an entry at EOF (rejects control bytes and '###')
npx collab-cue commit     --as me      record the reviewed hash
npx collab-cue close      --as me --open 0
npx collab-cue selftest
```

## Why it exists

Built from a collaboration that lost two rounds to the same three defects: an entry inserted
mid-file, an entry corrupted by ASCII control bytes, and a gate whose strictness depended on prose
formatting. `append` refuses the first two by construction; `--expect` makes the gate's id set an
input rather than a guess.

A background waiter is an accelerator, never the mechanism. `status` is the mechanism: it answers
whenever asked, and it cannot time out.

# TASK-0070: Relay and peer-handling costs: transaction seen-cache, scoring, banned peers, orphans, mempool eviction

Status: pending
Priority: P3
Size: medium
Depends on: TASK-0057
Source: F-052, F-053 (reassessment 3, 2026-11-27)

## Why

- **Seen-cache (F-052).** The transaction relay's seen-cache is keyed by txid, which excludes signatures, and is set before validation (`P2PServer.ts:950-960`). A copy with junk signatures sent first keeps the real transaction from being relayed by that node; only a later `MEMPOOL` exchange recovers it (reproduced).
- **Scoring (F-052).** No rejected transaction scores, not even one with invalid signatures or structure, contradicting AGENTS.md. Signatures are verified before inputs are looked up, and are cached even for rejected transactions (`Blockchain.ts:1455-1466`, `:352-358`), so a flood also pushes useful entries out of the signature cache.
- **Banned peers (F-053).** A banned peer's socket is only `close()`d. Its messages are still handled during ws's close timeout, and each one logs a WARN and rewrites `banned.json` synchronously (`P2PServer.ts:392-398`): 2,446 times in 5 seconds (reproduced). The ban list is pruned only on lookup.
- **Orphans (F-053).** Unsolicited `BLOCKS` messages of orphan blocks score nothing: about 180 ms of CPU per 16 MB message (reproduced).
- **Mempool eviction (F-053).** When full, `Mempool.add` sorts the whole pool on every call, also for a transaction it then refuses (`Mempool.ts:68-77`): about 3 ms at 42,000 entries (measured).

## Scope

- Key the transaction seen-cache on the witness hash, or mark a transaction seen only when it is accepted.
- Score transactions that are invalid regardless of chain state (structure, signatures). Policy and chain-state rejections stay free.
- Look up inputs before verifying signatures; cache signatures only for accepted transactions.
- After a ban, `terminate()` the socket and stop handling its messages; write `banned.json` once per ban, and prune expired bans when saving.
- Score unsolicited `BLOCKS` messages, or count orphan blocks against the sender.
- Check the cheapest eviction candidate before sorting, or keep the mempool ordered by fee rate.

## Acceptance criteria

- [ ] A junk-signature copy doesn't stop the real transaction from being relayed.
- [ ] An invalid-signature transaction scores its sender; a fee or conflict rejection doesn't.
- [ ] A banned peer's later messages cause no work, logs or file writes.
- [ ] Adding to a full mempool doesn't sort it when the new transaction can't replace anything.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

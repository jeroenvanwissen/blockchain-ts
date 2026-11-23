# TASK-0042: Block explorer page served by the node

Status: pending
Priority: P2
Size: medium
Depends on: TASK-0016
Source: owner request (2026-11-23)

## Why

The chain can only be inspected through JSON routes and the CLI. The owner asked for a block explorer page.

## Scope

- A static page served by the node's API at `/`: latest blocks, a block, a transaction, an address, the mempool and peers, plus a search box (height, block hash, txid, address).
- Uses only the public chain routes, never the wallet routes. Reads the chain, never changes it.
- The JSON routes it needs that don't exist yet: a block list, and transaction inputs annotated with the outputs they spend (address, amount) plus the fee.

## Acceptance criteria

- [ ] Opening `http://127.0.0.1:<API port>/` shows the explorer; every page is reachable by link and by search.
- [ ] Peer-controlled data is rendered as text, never as HTML. A strict Content-Security-Policy allows only the node's own script, style and API.
- [ ] The page's JavaScript is linted. Tests cover the new routes and the asset headers, and a headless browser renders the page against a real node.

## Validation

`npm run check`, `npm run smoke`.

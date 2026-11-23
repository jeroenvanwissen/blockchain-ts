# TASK-0042: Block explorer page served by the node

Status: done
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

- [x] Opening `http://127.0.0.1:<API port>/` shows the explorer; every page is reachable by link and by search.
- [x] Peer-controlled data is rendered as text, never as HTML. A strict Content-Security-Policy allows only the node's own script, style and API.
- [x] The page's JavaScript is linted. Tests cover the new routes and the asset headers, and a headless browser renders the page against a real node.

## Validation

`npm run check`, `npm run smoke`.

## Outcome

**Page:** `src/api/explorer/` holds `index.html`, `style.css` and `app.js`. The script is a browser ES module with no dependencies and hash routes:
- `#/`: the latest blocks, the mempool and the peers
- `#/blocks/<before>`: older blocks, a page at a time
- `#/block/<height or hash>`, `#/tx/<txid>` and `#/address/<address>`

The search box takes a height, a block hash or txid (tried as a block first), or an address. The status bar refreshes every 10 s, and the page re-renders when the tip changes. Light and dark themes follow the system setting, and the layout works on narrow screens.

**Safety**
- Every value from the API is inserted with `textContent`, through the `h()` helper; nothing is parsed as HTML.
- The page, script and stylesheet are served with:
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`, which JSON responses now get too
  - `Referrer-Policy: no-referrer`
- The files are read once at startup into a fixed route map, so no request path reaches the filesystem.
- The page uses only public chain routes.

**API additions**
- `GET /blocks?before=&limit=`: block summaries, newest first; `limit` up to 100.
- `/blocks/:id` adds each transaction's txid, the merkle root, size, producer (staker or coinbase payee) and `nextHash`.
- `/transactions/:txid` adds:
  - the output each input spends (`spent`), from the transaction index
  - whether each confirmed output is `unspent`
  - `fee` (null for coinbase and coinstake), `size`, `coinbase` and `coinstake`
- `Blockchain.getUTXO(txid, index)` added. The added fields don't change existing ones.

**Build:** `tsc` excludes `src/api/explorer`, and `npm run build` copies it to `dist/api/explorer`. The node passes the directory to `ApiServer` (`explorerDir`); without one, `/` is 404. ESLint lints `app.js` with browser globals.

**Tests**
- `Api.test.ts`:
  - `/blocks` paging and parameter errors
  - the block's txids, size, producer and `nextHash`
  - the transaction's spent outputs, fee, coinbase flags and unspent outputs
  - explorer content types and security headers
  - 404 for other names, including path traversal attempts
- Smoke: node A serves `/`, `app.js` and `style.css` with the CSP header.

**Runs**
- `npm run check`: 31 suites, 331 tests, lint clean.
- `npm run smoke`: PASS.
- The compiled node (`node dist/index.js`) serves the page and stops cleanly on SIGTERM.
- Headless Chrome against a regtest node that mined, staked and confirmed a CLI payment to a new address:
  - home, block, transaction and address pages rendered with live data, in dark and light themes and at 520 px width
  - unknown routes, invalid addresses and an HTML-injection attempt in the URL rendered as plain messages

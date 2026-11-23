// Block explorer (TASK-0042): one page over this node's public, read-only chain routes.
// Routes: #/ (latest blocks, mempool, peers), #/blocks/<before>, #/block/<height or hash>,
// #/tx/<txid>, #/address/<address>. Data from the API is only ever inserted as text.

const COIN = 100_000_000n;
const PAGE_SIZE = 20;
const MEMPOOL_SHOWN = 50;
const REFRESH_MS = 10_000;
const NULL_HASH = '0'.repeat(64);

const view = document.getElementById('view');
const statusBar = document.getElementById('status');
let lastTip = null;
let generation = 0; // bumped per render, so a slow response can't replace a newer page

/** An element with attributes and children; strings become text nodes, never markup. */
function h(tag, attributes = {}, ...children) {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined || value === null || value === false) continue;
		if (name === 'class') element.className = value;
		else element.setAttribute(name, String(value));
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue;
		element.append(child instanceof Node ? child : String(child));
	}
	return element;
}

const link = (href, text, className) => h('a', { href, class: className }, text);
const blockLink = (id, text = id) => link(`#/block/${encodeURIComponent(id)}`, String(text), /^[0-9a-f]{64}$/.test(id) ? 'mono' : undefined);
const txLink = (txid, text = txid) => link(`#/tx/${encodeURIComponent(txid)}`, text, 'mono');
const addressLink = (address) => link(`#/address/${encodeURIComponent(address)}`, address, 'mono');
const short = (hash) => `${hash.slice(0, 16)}…`;
const mono = (text) => h('span', { class: 'mono' }, text);
const muted = (text) => h('span', { class: 'muted' }, text);
const badge = (text, kind = 'plain') => h('span', { class: `badge ${kind}` }, text);
const typeBadge = (proofOfStake) => (proofOfStake ? badge('PoS', 'pos') : badge('PoW', 'pow'));

/** Base units (a decimal string) as coins: "1,234.5". */
function coins(units) {
	const value = BigInt(units);
	const fraction = (value % COIN).toString().padStart(8, '0').replace(/0+$/, '');
	return (value / COIN).toLocaleString('en-US') + (fraction ? `.${fraction}` : '');
}

const time = (ms) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

function ago(ms) {
	const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (seconds < 90) return `${seconds} s ago`;
	if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
	if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h ago`;
	return `${Math.round(seconds / 86_400)} days ago`;
}

class NotFound extends Error {}

/** GET a JSON route of this node's API. 400 and 404 mean "no such item". */
async function api(path) {
	const response = await fetch(path, { headers: { accept: 'application/json' } });
	const body = await response.json().catch(() => ({}));
	if (response.status === 400 || response.status === 404) throw new NotFound(body.error ?? 'not found');
	if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
	return body;
}

const cell = (content, className) => h('td', { class: className }, content);

/** A table: `columns` are [label, class]; each row is an array of cells. */
function table(columns, rows, empty = 'None.') {
	if (rows.length === 0) return h('p', { class: 'muted' }, empty);
	return h(
		'div',
		{ class: 'panel scroll' },
		h(
			'table',
			{},
			h('thead', {}, h('tr', {}, columns.map(([label, className]) => h('th', { class: className }, label)))),
			h('tbody', {}, rows.map((cells) => h('tr', {}, cells))),
		),
	);
}

/** A two-column list of facts; falsy entries are skipped. */
function facts(entries) {
	const rows = entries.filter(Boolean).map(([name, value]) => h('tr', {}, h('th', {}, name), h('td', {}, value)));
	return h('div', { class: 'panel' }, h('table', { class: 'facts' }, h('tbody', {}, rows)));
}

const message = (text, isProblem = false) => h('p', { class: isProblem ? 'notice' : 'muted' }, text);

async function blocksView(before) {
	const latest = before === undefined;
	const [blocks, mempool, peers] = await Promise.all([
		api(`/blocks?limit=${PAGE_SIZE}${latest ? '' : `&before=${before}`}`),
		latest ? api('/mempool') : null,
		latest ? api('/peers') : null,
	]);
	const rows = blocks.map((block) => [
		cell(blockLink(String(block.height), block.height)),
		cell(h('span', { title: time(block.timestamp) }, ago(block.timestamp))),
		cell(typeBadge(block.proofOfStake)),
		cell(block.transactions, 'num'),
		cell(block.size.toLocaleString('en-US'), 'num hide-narrow'),
		cell(block.producer ? link(`#/address/${encodeURIComponent(block.producer)}`, short(block.producer), 'mono') : muted('none'), 'hide-narrow'),
		cell(blockLink(block.hash, short(block.hash)), 'hide-narrow'),
	]);
	const newest = blocks[0]?.height;
	const oldest = blocks[blocks.length - 1]?.height;
	const pager = h(
		'div',
		{ class: 'pager' },
		latest ? h('span') : link(newest + PAGE_SIZE + 1 > lastHeight() ? '#/' : `#/blocks/${newest + PAGE_SIZE + 1}`, '← Newer'),
		oldest > 0 ? link(`#/blocks/${oldest}`, 'Older →') : h('span'),
	);
	const parts = [
		h('h1', {}, latest ? 'Latest blocks' : `Blocks below height ${before}`),
		table(
			[['Height'], ['Age'], ['Type'], ['Txs', 'num'], ['Bytes', 'num hide-narrow'], ['Producer', 'hide-narrow'], ['Hash', 'hide-narrow']],
			rows,
		),
		pager,
	];
	if (latest) {
		const pending = mempool.txids.slice(0, MEMPOOL_SHOWN).map((txid) => h('li', {}, txLink(txid)));
		const more = mempool.size > MEMPOOL_SHOWN ? h('p', { class: 'muted' }, `and ${mempool.size - MEMPOOL_SHOWN} more`) : null;
		parts.push(
			h('h2', {}, `Mempool: ${mempool.size} transaction(s), ${mempool.bytes.toLocaleString('en-US')} bytes`),
			pending.length ? h('div', { class: 'panel tx' }, h('ul', { class: 'plain-list' }, pending), more) : message('No transactions are waiting.'),
			h('h2', {}, `Peers: ${peers.length}`),
			table(
				[['Address'], ['Direction'], ['Height at connect', 'num']],
				peers.map((peer) => [cell(mono(peer.address)), cell(peer.inbound ? 'inbound' : 'outbound'), cell(peer.startHeight, 'num')]),
				'Not connected to any peer.',
			),
		);
	}
	return parts;
}

/** A transaction inside a block: where its coins come from and go. */
function txSummary(tx, index, proofOfStake) {
	const kind = index === 0 ? 'coinbase' : index === 1 && proofOfStake ? 'coinstake' : null;
	const total = tx.outputs.reduce((sum, output) => sum + BigInt(output.amount), 0n);
	const inputs =
		kind === 'coinbase'
			? [h('li', {}, muted('New coins: block reward plus fees'))]
			: tx.inputs.map((input) => h('li', {}, txLink(input.previousTx, `${short(input.previousTx)}:${input.outputIndex}`)));
	const outputs = tx.outputs.map((output) =>
		h('li', {}, output.amount === '0' ? muted('stake marker') : addressLink(output.address), h('span', {}, coins(output.amount))),
	);
	return h(
		'div',
		{ class: 'tx' },
		h('div', { class: 'tx-head' }, txLink(tx.txid), kind && badge(kind), muted(`${coins(total)} coins out`)),
		h('div', { class: 'flow' }, h('ul', {}, inputs), h('div', { class: 'arrow' }, '→'), h('ul', {}, outputs)),
	);
}

async function blockView(id) {
	const block = await api(`/blocks/${encodeURIComponent(id)}`);
	const hasParent = block.previousHash !== NULL_HASH;
	return [
		h('h1', {}, `Block ${block.index}`),
		!block.active && message('This block is on a side branch: it is not part of the active chain.', true),
		facts([
			['Hash', mono(block.hash)],
			['Height', block.index],
			['Confirmations', block.active ? block.confirmations : 'none (side branch)'],
			['Time', `${time(block.timestamp)} (${ago(block.timestamp)})`],
			['Type', h('span', {}, typeBadge(block.proofOfStake), block.proofOfStake ? ' proof of stake' : ' proof of work')],
			[block.proofOfStake ? 'Staked by' : 'Reward to', block.producer ? addressLink(block.producer) : muted('none')],
			['Previous block', hasParent ? blockLink(block.previousHash) : muted('none: this is the genesis block')],
			['Next block', block.nextHash ? blockLink(block.nextHash) : muted(block.active ? 'none yet' : 'not on the active chain')],
			['Transactions', block.transactions.length],
			['Size', `${block.size.toLocaleString('en-US')} bytes`],
			['Target (bits)', mono(`0x${block.bits.toString(16).padStart(8, '0')}`)],
			!block.proofOfStake && ['Nonce', block.nonce],
			['Merkle root', mono(block.merkleRoot)],
			block.proofOfStake && ['Block signature', mono(block.signature)],
			['Version', block.version],
		]),
		h('h2', {}, `Transactions (${block.transactions.length})`),
		h('div', { class: 'panel' }, block.transactions.map((tx, i) => txSummary(tx, i, block.proofOfStake))),
	];
}

async function txView(txid) {
	const tx = await api(`/transactions/${encodeURIComponent(txid)}`);
	const kind = tx.coinbase ? 'coinbase' : tx.coinstake ? 'coinstake (stakes a block)' : 'payment';
	const inputRows = tx.coinbase
		? [[cell('0'), cell(muted('New coins: block reward plus fees')), cell(''), cell('', 'num')]]
		: tx.inputs.map((input, i) => [
				cell(i),
				cell(txLink(input.previousTx, `${short(input.previousTx)}:${input.outputIndex}`)),
				cell(input.spent ? addressLink(input.spent.address) : muted('unknown')),
				cell(input.spent ? coins(input.spent.amount) : '', 'num'),
			]);
	const outputState = (output) => (output.unspent === null ? muted('—') : output.unspent ? 'unspent' : muted('spent'));
	const outputRows = tx.outputs.map((output, i) => [
		cell(i),
		cell(output.amount === '0' ? muted('stake marker (no coins)') : addressLink(output.address)),
		cell(coins(output.amount), 'num'),
		cell(outputState(output)),
	]);
	return [
		h('h1', {}, 'Transaction'),
		facts([
			['Txid', mono(tx.txid)],
			[
				'Status',
				tx.block
					? h('span', {}, 'In block ', blockLink(String(tx.height), tx.height), `, ${tx.confirmations} confirmation(s)`)
					: 'In the mempool, waiting for a block',
			],
			['Time', `${time(tx.timestamp)} (${ago(tx.timestamp)})`],
			['Type', kind],
			['Fee', tx.fee === null ? muted('none') : `${coins(tx.fee)} coins`],
			['Size', `${tx.size.toLocaleString('en-US')} bytes`],
			['Version', tx.version],
		]),
		h('h2', {}, `Inputs (${tx.inputs.length})`),
		table([['#'], ['Spends'], ['From'], ['Coins', 'num']], inputRows),
		h('h2', {}, `Outputs (${tx.outputs.length})`),
		table([['#'], ['To'], ['Coins', 'num'], ['State']], outputRows),
	];
}

async function addressView(address) {
	const path = `/addresses/${encodeURIComponent(address)}`;
	const [info, utxos] = await Promise.all([api(path), api(`${path}/utxos`)]);
	const kind = (utxo) => (utxo.coinbase ? 'coinbase' : utxo.coinstake ? 'stake' : 'payment');
	return [
		h('h1', {}, 'Address'),
		facts([
			['Address', mono(info.address)],
			['Balance', `${coins(info.balance)} coins`],
			['Spendable now', `${coins(info.spendable)} coins`],
			['Unspent outputs', info.utxos],
		]),
		h('h2', {}, 'Unspent outputs'),
		table(
			[['Output'], ['Coins', 'num'], ['Block'], ['Confirmations', 'num hide-narrow'], ['Kind', 'hide-narrow'], ['Spendable']],
			utxos.map((utxo) => [
				cell(txLink(utxo.txid, `${short(utxo.txid)}:${utxo.outputIndex}`)),
				cell(coins(utxo.amount), 'num'),
				cell(blockLink(String(utxo.height), utxo.height)),
				cell(utxo.confirmations, 'num hide-narrow'),
				cell(kind(utxo), 'hide-narrow'),
				cell(utxo.spendable ? 'yes' : muted('not yet (maturing or in the mempool)')),
			]),
			'No unspent outputs.',
		),
		h('p', { class: 'muted' }, 'The node indexes unspent outputs only, so spent history is not shown.'),
	];
}

let statusHeight = null;
const lastHeight = () => statusHeight ?? Infinity;

async function updateStatus() {
	const status = await api('/status');
	statusHeight = status.height;
	const item = (label, value) => h('span', {}, `${label}: `, h('b', {}, value));
	statusBar.replaceChildren(
		item('Network', status.network),
		item('Height', blockLink(String(status.height), status.height)),
		item('Phase', status.phase === 'pos' ? 'proof of stake' : 'proof of work'),
		item('Peers', status.peers),
		item('Mempool', `${status.mempool} tx`),
	);
	return status;
}

async function render() {
	const current = ++generation;
	const [, route = '', argument = ''] = /^#\/([a-z]*)\/?(.*)$/.exec(location.hash) ?? [];
	let content;
	try {
		const value = decodeURIComponent(argument);
		if (route === '') content = await blocksView();
		else if (route === 'blocks' && /^\d+$/.test(value)) content = await blocksView(Number(value));
		else if (route === 'block' && value) content = await blockView(value);
		else if (route === 'tx' && value) content = await txView(value);
		else if (route === 'address' && value) content = await addressView(value);
		else content = message('There is no such page.', true);
	} catch (error) {
		content = error instanceof NotFound ? message(`Nothing found: ${error.message}.`) : message(`Could not load this page: ${error.message}`, true);
	}
	if (current !== generation) return; // the user moved on while this loaded
	view.replaceChildren(...[content].flat().filter(Boolean));
}

async function exists(path) {
	try {
		await api(path);
		return true;
	} catch {
		return false;
	}
}

/** Heights, block hashes, txids and addresses; a 64-hex string is a block if one has that hash. */
async function search(event) {
	event.preventDefault();
	const input = document.getElementById('query');
	const query = input.value.trim();
	if (!query) return;
	let target;
	if (/^\d+$/.test(query)) target = `#/block/${query}`;
	else if (/^[0-9a-fA-F]{64}$/.test(query)) {
		const id = query.toLowerCase();
		target = (await exists(`/blocks/${id}`)) ? `#/block/${id}` : `#/tx/${id}`;
	} else target = `#/address/${encodeURIComponent(query)}`;
	input.value = '';
	if (location.hash === target) void render();
	else location.hash = target;
}

/** Refresh the status bar; re-render the page when a new block arrived. */
async function refresh() {
	try {
		const status = await updateStatus();
		if (lastTip !== null && status.tip !== lastTip) await render();
		lastTip = status.tip;
	} catch {
		statusBar.replaceChildren(h('span', {}, 'The node is not answering.'));
	}
}

document.getElementById('search').addEventListener('submit', (event) => void search(event));
window.addEventListener('hashchange', () => {
	window.scrollTo(0, 0);
	void render();
});
void refresh().then(render);
setInterval(() => void refresh(), REFRESH_MS);

# TASK-0041: HD wallet with any number of addresses

Status: done
Priority: P2
Size: large
Depends on: TASK-0024
Source: owner request (2026-11-23)

## Why

The wallet had one key, so one address: every payer, every mining reward and every staked block used the same address. The owner asked for multiple wallet addresses.

## Scope

- Hand out new receiving addresses, list them with balances, and count the balance over all of them.
- Spend from all addresses and stake with outputs on any of them.
- A backup made once should cover addresses created later.
- Existing wallets, encrypted or not, keep working and keep their address.

## Acceptance criteria

- [x] `cli new-address` / `POST /wallet/addresses` hands out a new address, also while the wallet is locked; `cli addresses` / `GET /wallet/addresses` lists them with balances; `GET /wallet` and `cli balance` total all addresses.
- [x] Payments take outputs from all addresses, each input signed by its own key; change goes to the primary address.
- [x] Outputs on any address stake; the coinstake, the reward and the block signature use that address.
- [x] A copy of `wallet.dat` made before new addresses were handed out still owns them (up to the lookahead).
- [x] Older single-key wallets keep their address as the primary one and gain a seed: unencrypted ones at load, encrypted ones at the first unlock.
- [x] Encryption covers the seed; no secret is written unencrypted for an encrypted wallet.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Key derivation (`hd.ts`)**
- BIP32 with the standard master-key constant: `masterKey`, `derivePrivate` (hardened and normal), `derivePublic`, `neuter`, `derivePath`.
- Checked against BIP32 test vector 1 through m/0H/1/2H. Public derivation matches private derivation for normal children.
- Indexes BIP32 says to skip (probability about 2^-127 each) return null, and the wallet skips them.

**Wallet**
- Receiving addresses are m/0'/0/i. The file stores:
  - the seed, encrypted when the wallet is
  - the account public key and chain code (m/0'), so `newAddress()` works while locked
  - how many addresses were handed out
- The wallet watches `WALLET_ADDRESS_LOOKAHEAD` (20) more addresses, so coins sent to addresses made after a backup still show up when that backup is restored.
- The primary address (mining rewards, change, the `Wallet initialized with address:` log line) is receiving address 0. In an older wallet it's that wallet's single key, which stays in the file next to the seed.
- Older wallets get a seed: unencrypted ones when loaded, encrypted ones at the first `unlock` (or `change-passphrase`), when the passphrase is known. Until then `newAddress()` is refused with a request to unlock once.
- The encrypted payload is the seed followed by the old key, if any. The additional authenticated data is the public keys it belongs to. A file in the TASK-0024 format, which has the old key only and its public key as AAD, still decrypts.
- `signTransaction(tx, purpose, owners)` signs input i with the key of `owners[i]`, deriving the private key per input and wiping it afterwards. `signDigest(digest, owner)` signs a PoS block. Without `owners`, every input is signed with the primary key, as before.
- `Transaction.signInput(i, key)` added.

**Chain**
- `createPayment(wallet, outputs)` spends from all the wallet's addresses and sends change to the primary address. `createTransaction(from, …)` still spends from `from` only.
- `createStakeBlock` looks for kernels among outputs on any wallet address. The coinstake, coinbase and block signature use the kernel's address, as consensus already required.
- `getStakeableUTXOs`, `getStakingOutlook` and `findLastStakedBlock` take a list of addresses; `getWalletUTXOs(addresses)` was added.

**API and CLI**
- New routes `GET /wallet/addresses` (handed-out addresses, plus watched ones holding coins, with balances) and `POST /wallet/addresses`. Both are wallet routes: token and loopback only.
- `GET /wallet` reports `addresses` (the count handed out) and balances over all addresses.
- CLI: `new-address` and `addresses`; `balance` prints the address count.

**Change policy:** change goes to the primary address, not to a fresh change address. Fresh change addresses would leave a backup unable to find coins once more than 20 sequential payments followed it. The UTXO set records no address history, so a restore couldn't scan past such a gap.

**Tests**
- `hd.test.ts`: the BIP32 vectors, public against private derivation, and hardened public derivation refused.
- `WalletAddresses.test.ts`:
  - addresses survive a restart and sign with their own keys
  - the lookahead from a backup
  - new addresses while locked
  - upgrading older unencrypted and encrypted files (written in the TASK-0024 format)
  - a payment spending outputs of two addresses, mined
  - a PoS block staked from a non-primary address, accepted
- `Api.test.ts`: the address routes.
- Smoke: `cli new-address` and `cli addresses`, and the new address is still listed after a SIGTERM restart. The encryption check now looks for the seed.
- e2e: A pays C on an address C made with `cli new-address`, and C then stakes those coins.

**Runs**
- `npm run check`: 31 suites, 328 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS (height 25, 5 PoS blocks). C's only coins were the payment to its new address, so its staked blocks came from a non-primary address.

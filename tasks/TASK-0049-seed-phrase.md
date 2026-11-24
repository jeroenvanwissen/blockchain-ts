# TASK-0049: Seed-phrase backup and restore (BIP39)

Status: done
Priority: P2
Size: medium
Depends on: TASK-0041
Source: owner request (2026-11-24)

## Why

The only wallet backup is a copy of `wallet.dat`: a binary file that has to be kept somewhere safe and copied again whenever it changes. A seed phrase is 24 words written on paper, and it recreates every address of the wallet on any node.

## Scope

- New wallets get a BIP39 seed: 256 bits of entropy, shown as 24 English words. The BIP32 seed is the standard BIP39 derivation of those words (PBKDF2-HMAC-SHA512, no BIP39 passphrase), and the addresses keep the m/0'/0/i path.
- Show the phrase through the API and CLI (`cli seed-phrase`). An encrypted wallet asks for its passphrase every time, without unlocking it.
- Restore a wallet from the words with the node stopped (`cli restore-wallet`, optionally encrypting it at once). A restored node finds the addresses that were in use, including ones beyond the lookahead, as it syncs.
- Wallets created before this have a raw seed that no phrase can express. They keep working, and the phrase commands say to back up `wallet.dat` instead. The same applies to wallets whose primary address is an older single key.

## Acceptance criteria

- [x] The BIP39 code reproduces the reference test vectors (entropy, words, seed and BIP32 root key), and the wordlist matches the published file's SHA-256.
- [x] A restored wallet has the same addresses as the original; wrong words, a wrong count or a bad checksum are refused with a clear reason; restore never overwrites an existing `wallet.dat`.
- [x] An encrypted wallet shows its phrase only with the right passphrase and stays locked; the phrase never appears in the node's log.
- [x] After a restore the wallet watches every used address, also past the 20-address lookahead.
- [x] Older wallets keep loading, unlocking and signing unchanged.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run docker:check`, plus restores on real regtest nodes and in the Docker image.

## Outcome

**BIP39 (`bip39.ts`, `bip39Wordlist.ts`)**
- Implemented on Node's crypto, without a new dependency:
  - `entropyToMnemonic`: the entropy plus SHA-256 checksum bits, 11 bits per word
  - `mnemonicToEntropy`: throws a `MnemonicError` that names the problem (word count, which word isn't in the list, or the checksum) without repeating the words
  - `mnemonicToSeed`: PBKDF2-HMAC-SHA512, 2048 rounds, NFKD
- The English word list is embedded; a test checks it against the SHA-256 of the published `english.txt`.
- All 24 reference vectors pass: entropy to words and back, the seed with the passphrase `TREZOR`, and the BIP32 root key through `hd.ts`.

**Wallet**
- New wallets store 32 bytes of BIP39 entropy in the existing `seed` field, with `seed_format = 1` (WalletData field 11). The BIP32 seed is derived from the 24 words; addresses stay m/0'/0/i.
- Because the stored secret is still 32 bytes, the encrypted layout and its authenticated data are unchanged. Older encrypted wallets decrypt as before.
- Wallets from TASK-0041 have no format, so their raw seed is used as it is. Older single-key wallets that get upgraded receive a BIP39 seed, but can't be restored from it because their primary address is the single key.
- `hasSeedPhrase()`: true only for BIP39 wallets without a single key.
- `seedPhrase(passphrase?)`: an encrypted wallet always needs its passphrase. The phrase is decrypted into a copy that is wiped afterwards, and the lock state doesn't change. Wallets without a phrase throw `WalletError('no-seed-phrase')` with the reason.
- `Wallet.restore(phrase, path, passphrase?)`: exactly 24 words. Never replaces an existing file. With a passphrase it encrypts before the first write; a weak passphrase writes nothing.
- `discoverUsedAddresses(isUsed, gap = 100)`: scans receiving addresses past the ones handed out, deriving them on the fly beyond the watched lookahead. Everything up to the last one with chain history becomes handed out; the address count is saved.
- The node runs this at startup and every minute (`WALLET_DISCOVERY_INTERVAL`), so a restored wallet finds its addresses as the chain arrives, and logs `wallet: found N more address(es) in use`.
- Why the scan goes 100 addresses deep: on a real node, a wallet that had handed out 30 addresses with only the last one paid stayed 3 coins short until discovery looked past the 20-address lookahead.

**API and CLI**
- `POST /wallet/seed-phrase` returns `{phrase}`; an encrypted wallet needs `{passphrase}` (400 without it, 403 if wrong); a wallet without a phrase gets 409.
- `GET /wallet` adds `seedPhrase`, and `cli balance` prints which backup applies.
- `cli seed-phrase` prints the words numbered in rows of four, with a warning on stderr.
- `cli restore-wallet [--encrypt]` works offline on the data dir:
  - it refuses an existing `wallet.dat` before asking for anything
  - it reads the words over as many lines as needed, plain or numbered (not echoed on a terminal; from stdin otherwise)
  - it asks for and checks the passphrase before writing anything
- Docker: the README shows the restore into the volume with `docker compose run --entrypoint cli`.

**Tests**
- `bip39.test.ts`: the word-list hash, all 24 reference vectors, and input handling (spaces and capitals accepted; a wrong count, an unknown word or a bad checksum refused).
- `WalletSeedPhrase.test.ts`, 8 tests:
  - restore gives the same addresses and identical signatures
  - an encrypted restore never puts the seed on disk, and a weak passphrase writes nothing
  - invalid phrases are refused, and an existing file is never replaced
  - an encrypted wallet needs its passphrase every time, also while unlocked, and stays locked
  - a raw-seed wallet keeps loading, encrypting, unlocking and signing, without a phrase
  - a single-key wallet has no phrase
  - discovery finds used addresses past the lookahead in one pass, and finds one after 99 unused addresses but not after 101
- `Api.test.ts`: the route's status codes, a round trip through `Wallet.restore`, and that the wallet stays locked.
- Smoke:
  - shows A's phrase and restores it twice: from the numbered output, and as one line with `--encrypt`. Both give A's address, and the encrypted file holds no seed.
  - restoring over A's wallet is refused
  - after A's restart (encrypted) the passphrase gives the same phrase
  - the phrase never appears in node output
- Mutation checks: skipping the checksum fails 2 tests; showing an unlocked encrypted wallet's phrase without the passphrase fails 1.

## Runs

- `npm run check`: 36 suites, 382 tests, lint clean.
- `npm run smoke`: PASS with the seed-phrase steps.
- `npm run e2e`: PASS (height 27, 7 PoS blocks).
- `npm run docker:check`: PASS. Then, with the new image (`blockchain-ts:check`), a scratch volume and plain `docker run`:
  - `restore-wallet` was refused while the container's `wallet.dat` existed
  - after `--entrypoint mv`, the restore with `--encrypt` wrote the original's address
  - the restarted container reported it as encrypted and locked with a seed phrase backup, file mode 0600, and no warnings
- Real regtest nodes:
  1. A handed out 30 addresses and paid 3 coins to #30. Its phrase was restored into node B, which synced from A.
  2. With the first discovery (lookahead only), B was 3 coins short. With the 100-address scan, B's restart found 30 addresses and B's balance equaled A's (320).
  3. A third node restored from the same phrase started at height 0, synced 34 blocks, and the next minute's scan found all 30 addresses (balance 380, the same as A's).

// Load secp256k1 before test files run. Several unit tests call jest.mock('fs'), and
// secp256k1 locates its native prebuilt addon through fs; under a mocked fs it silently
// falls back to the pure-JS implementation, which is orders of magnitude slower.
// Modules loaded here stay cached for the test file.
require('secp256k1');

// Tests never touch the real data dir: the default paths (DATA_DIR, BLOCKS_DIR, the chain
// database) point at a directory that doesn't exist, so a test that forgets to pass its own
// location fails instead of writing to the node's data.
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `blockchain-ts-jest-${process.pid}-no-data-dir`);

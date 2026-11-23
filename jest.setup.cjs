// Load secp256k1 before test files run. Several unit tests call jest.mock('fs'), and
// secp256k1 locates its native prebuilt addon through fs; under a mocked fs it silently
// falls back to the pure-JS implementation, which is orders of magnitude slower.
// Modules loaded here stay cached for the test file.
require('secp256k1');

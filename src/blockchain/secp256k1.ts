import * as secp256k1Namespace from 'secp256k1';

type Secp256k1 = typeof secp256k1Namespace;

// secp256k1 is a CommonJS package without statically detectable named exports.
// Under native ESM (tsx, node dist/) the namespace import only exposes `default`;
// under ts-jest (compiled to CommonJS) `default` is added by esModuleInterop.
// Reading `default` first works in both environments.
export const secp256k1: Secp256k1 =
	(secp256k1Namespace as unknown as { default?: Secp256k1 }).default ?? secp256k1Namespace;

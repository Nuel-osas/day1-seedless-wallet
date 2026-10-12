// A software WebAuthn authenticator implementing the SDK's PasskeyProvider interface.
// Produces real authenticatorData / clientDataJSON / DER signatures, so the chain verifies
// it exactly like Face ID. For rehearsals and CI only: the key lives in memory.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { PasskeyProvider } from '@mysten/sui/keypairs/passkey';

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

export class SoftPasskeyProvider implements PasskeyProvider {
	readonly secretKey: Uint8Array;
	readonly credentialId = randomBytes(16);
	constructor(private rpId = 'localhost', private origin = 'http://localhost:5291', secretKey?: Uint8Array) {
		this.secretKey = secretKey ?? p256.utils.randomSecretKey();
	}
	private authData() {
		const counter = new Uint8Array(4);
		return new Uint8Array([...sha256(new TextEncoder().encode(this.rpId)), 0x05, ...counter]);
	}
	async create() {
		const pub = p256.getPublicKey(this.secretKey, false); // 65 bytes uncompressed
		// DER SubjectPublicKeyInfo for an EC P-256 key
		const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
		const spki = new Uint8Array([...prefix, ...pub]);
		return {
			rawId: this.credentialId.buffer,
			response: { getPublicKey: () => spki.buffer },
		} as unknown as Awaited<ReturnType<PasskeyProvider['create']>>;
	}
	async get(challenge: Uint8Array) {
		const authenticatorData = this.authData();
		const clientDataJSON = new TextEncoder().encode(
			JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: this.origin, crossOrigin: false }),
		);
		const msg = new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]);
		const sig = p256.sign(msg, this.secretKey, { format: 'der' }); // hashes msg with sha256
		return {
			rawId: this.credentialId.buffer,
			response: {
				authenticatorData: authenticatorData.buffer,
				clientDataJSON: clientDataJSON.buffer,
				signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength),
			},
		} as unknown as Awaited<ReturnType<PasskeyProvider['get']>>;
	}
}

import {
	BrowserPasskeyProvider,
	findCommonPublicKey,
	PasskeyKeypair,
	type PasskeyProvider,
} from '@mysten/sui/keypairs/passkey';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

export const RP_NAME = 'Face ID Wallet';

// Wraps the SDK provider to remember which credential answered, so later signatures can pass
// allowCredentials and the OS does not show a chooser when several passkeys exist for this site.
class TrackingProvider implements PasskeyProvider {
	lastCredentialId?: Uint8Array;
	constructor(private inner: BrowserPasskeyProvider) {}
	async create() {
		const c = await this.inner.create();
		this.lastCredentialId = new Uint8Array(c.rawId);
		return c;
	}
	async get(challenge: Uint8Array, credentialId?: Uint8Array) {
		const c = await this.inner.get(challenge, credentialId);
		this.lastCredentialId = new Uint8Array(c.rawId);
		return c;
	}
}

function provider(label = RP_NAME) {
	return new TrackingProvider(
		new BrowserPasskeyProvider(RP_NAME, {
			// rp.id defaults to the page's host. The passkey only ever works on this host.
			rp: { id: window.location.hostname, name: RP_NAME },
			user: { name: label, displayName: label },
			authenticatorSelection: {
				// SDK default is 'cross-platform' (phone or security key only). Leaving it unset lets
				// the OS offer Touch ID / Face ID / Windows Hello as well as a phone.
				authenticatorAttachment: undefined,
				residentKey: 'required',
				userVerification: 'required',
			},
		}),
	);
}

export type StoredPasskey = {
	kind: 'passkey';
	label: string;
	address: string;
	publicKey: string; // base64 compressed secp256r1
	credentialId?: string;
};

// Registration. The public key is only returned here, so it must be persisted.
export async function createPasskey(label: string): Promise<StoredPasskey> {
	const p = provider(label);
	const kp = await PasskeyKeypair.getPasskeyInstance(p);
	return {
		kind: 'passkey',
		label,
		address: kp.toSuiAddress(),
		publicKey: toBase64(kp.getPublicKey().toRawBytes()),
		credentialId: kp.getCredentialId() ? toBase64(kp.getCredentialId()!) : undefined,
	};
}

// Returning user on a device with no stored public key: an ECDSA signature yields up to four
// candidate public keys; two signatures over different messages share exactly one.
export async function recoverPasskey(label: string): Promise<StoredPasskey> {
	const p = provider(label);
	const enc = new TextEncoder();
	const a = await PasskeyKeypair.signAndRecover(p, enc.encode(`${RP_NAME}: sign in (1/2) ${Date.now()}`));
	const credentialId = p.lastCredentialId;
	const b = await PasskeyKeypair.signAndRecover(p, enc.encode(`${RP_NAME}: sign in (2/2) ${Date.now()}`));
	const pk = findCommonPublicKey(a, b);
	return {
		kind: 'passkey',
		label,
		address: pk.toSuiAddress(),
		publicKey: toBase64(pk.toRawBytes()),
		credentialId: credentialId ? toBase64(credentialId) : undefined,
	};
}

export function passkeySigner(k: StoredPasskey) {
	return new PasskeyKeypair(fromBase64(k.publicKey), provider(k.label), k.credentialId ? fromBase64(k.credentialId) : undefined);
}

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { makeClient } from '../shared/sui';
import type { StoredPasskey } from './passkey';

export const client = makeClient();

export type StoredGuardian = { kind: 'guardian'; label: string; address: string };
export type StoredKey = StoredPasskey | StoredGuardian;

// The account address never changes. The signer is whichever key currently authorises it:
// the account's own passkey, or an alias (recovery passkey, guardian, rotated passkey).
export type WalletState = { account: string; signer: StoredKey };

const KEY = 'faceid-wallet-v1';
const LAST = 'faceid-wallet-last-account';
const DEVICE_KEYS = 'faceid-wallet-device-keys';

export const storage = {
	load(): WalletState | null {
		try {
			return JSON.parse(localStorage.getItem(KEY) ?? 'null');
		} catch {
			return null;
		}
	},
	save(w: WalletState) {
		localStorage.setItem(KEY, JSON.stringify(w));
		localStorage.setItem(LAST, w.account);
		if (w.signer.kind === 'passkey') this.rememberDeviceKey(w.signer);
	},
	clear() {
		localStorage.removeItem(KEY);
	},
	lastAccount: () => localStorage.getItem(LAST) ?? '',
	// Public keys of passkeys created on this device, so a recovery device can sign without
	// the two-signature recovery dance.
	deviceKeys(): StoredPasskey[] {
		try {
			return JSON.parse(localStorage.getItem(DEVICE_KEYS) ?? '[]');
		} catch {
			return [];
		}
	},
	rememberDeviceKey(k: StoredPasskey) {
		const keys = this.deviceKeys().filter((x) => x.address !== k.address);
		localStorage.setItem(DEVICE_KEYS, JSON.stringify([...keys, k]));
	},
	forgetDeviceKey(address: string) {
		localStorage.setItem(DEVICE_KEYS, JSON.stringify(this.deviceKeys().filter((x) => x.address !== address)));
	},
};

let sponsorAddress: string | undefined;
export async function getConfig(): Promise<{ sponsor: string; network: string; deepseek: boolean }> {
	const c = await fetch('/api/config').then((r) => r.json());
	sponsorAddress = c.sponsor;
	return c;
}

async function api<T>(path: string, body: unknown): Promise<T> {
	const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const j = await r.json();
	if (!r.ok || j.error) throw new Error(j.error ?? r.statusText);
	return j as T;
}

export type Preview = {
	preview: string | null;
	facts: { sender: string; gasOwner: string; commands: string[]; balanceChanges: string[]; simulation: string };
};

// 1. build with the sponsor as gas owner, gas from its address balance (payment = [])
export async function prepare(account: string, signerAddress: string, build: (tx: Transaction) => void) {
	if (!sponsorAddress) await getConfig();
	const tx = new Transaction();
	tx.setSender(account);
	tx.setGasOwner(sponsorAddress!);
	tx.setGasPayment([]);
	build(tx);
	const bytes = await tx.build({ client });
	// 2. "What am I signing?" before the OS prompt
	const preview = await api<Preview>('/api/explain', { txBytes: toBase64(bytes), signerAddress });
	return { bytes, preview };
}

// 3. passkey prompt, 4. sponsor co-signs and executes
export async function approve(bytes: Uint8Array, signer: Signer) {
	const { signature } = await signer.signTransaction(bytes);
	const out = await api<{ digest: string; ok: boolean; error: unknown }>('/api/sponsor', { txBytes: toBase64(bytes), signature });
	if (!out.ok) throw new Error(`Transaction ${out.digest} failed: ${JSON.stringify(out.error)}`);
	return out.digest;
}

export const fund = (address: string, coin: 'SUI' | 'USDC') => api<{ digest: string }>('/api/fund', { address, coin });

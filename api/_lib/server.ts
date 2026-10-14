// Server-only helpers. The sponsor key comes from SPONSOR_SECRET_KEY and never reaches the browser.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { makeClient } from '../../src/shared/sui.js';

export const client = makeClient();

let sponsor: Ed25519Keypair | undefined;
export function getSponsor() {
	if (!sponsor) {
		const secret = process.env.SPONSOR_SECRET_KEY;
		if (!secret) throw new Error('SPONSOR_SECRET_KEY is not set');
		sponsor = Ed25519Keypair.fromSecretKey(secret);
	}
	return sponsor;
}

export const MAX_GAS_BUDGET = 50_000_000n; // 0.05 SUI per transaction

const ALLOWED_TARGETS = new Set([
	'0x2::balance::send_funds',
	// SUI that arrives from a wallet or faucet is a Coin object, not address balance. The SDK then
	// splits it and sends the change back with coin::send_funds. Still only the sender's own funds.
	'0x2::coin::send_funds',
	'0x2::balance::redeem_funds',
	'0x2::coin::redeem_funds',
	'0x2::coin::into_balance',
	'0x2::coin::from_balance',
	'0x2::coin::split',
	'0x2::coin::join',
	'0x2::coin::zero',
	'0x2::balance::split',
	'0x2::balance::join',
	'0x2::balance::zero',
	'0x2::address_alias::enable',
	'0x2::address_alias::add',
	'0x2::address_alias::remove',
	'0x2::address_alias::replace_all',
]);

const short = (pkg: string) => normalizeSuiAddress(pkg).replace(/^0x0+(?=[0-9a-f])/, '0x');

// A sponsor signs as a required signer, so anything the sponsor owns is reachable from the
// transaction. This policy is what stops a user from spending the sponsor's coins or
// withdrawing from the sponsor's address balance.
export async function checkSponsorable(txBytes: Uint8Array) {
	const sponsorAddr = getSponsor().toSuiAddress();
	const data = Transaction.from(txBytes).getData();

	if (!data.sender) throw new Error('missing sender');
	if (normalizeSuiAddress(data.sender) === sponsorAddr) throw new Error('sender cannot be the sponsor');
	if (!data.gasData.owner || normalizeSuiAddress(data.gasData.owner) !== sponsorAddr)
		throw new Error('gas owner must be the sponsor');
	if (data.gasData.payment?.length !== 0) throw new Error('gas must come from the sponsor address balance');
	if (BigInt(data.gasData.budget ?? 0) > MAX_GAS_BUDGET) throw new Error('gas budget too high');
	if (data.expiration?.$kind !== 'ValidDuring') throw new Error('address-balance gas needs a ValidDuring expiration');

	const objectIds: string[] = [];
	for (const input of data.inputs) {
		if (input.$kind === 'FundsWithdrawal' && input.FundsWithdrawal.withdrawFrom.$kind !== 'Sender')
			throw new Error('only withdrawals from the sender are sponsored');
		if (input.$kind === 'Object') {
			const o = input.Object;
			objectIds.push(
				o.$kind === 'ImmOrOwnedObject' ? o.ImmOrOwnedObject.objectId
				: o.$kind === 'SharedObject' ? o.SharedObject.objectId
				: o.Receiving.objectId,
			);
		}
	}
	for (const cmd of data.commands) {
		if (cmd.$kind === 'MoveCall') {
			const t = `${short(cmd.MoveCall.package)}::${cmd.MoveCall.module}::${cmd.MoveCall.function}`;
			if (!ALLOWED_TARGETS.has(t)) throw new Error(`call not sponsored: ${t}`);
		} else if (!['TransferObjects', 'SplitCoins', 'MergeCoins'].includes(cmd.$kind)) {
			throw new Error(`command not sponsored: ${cmd.$kind}`);
		}
	}
	if (objectIds.length) {
		const { objects } = await client.core.getObjects({ objectIds });
		for (const o of objects) {
			if (o instanceof Error) continue;
			const owner = o.owner;
			if (owner.$kind === 'AddressOwner' && normalizeSuiAddress(owner.AddressOwner) === sponsorAddr)
				throw new Error('transaction touches a sponsor-owned object');
		}
	}
	return data;
}

export function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function readJson<T>(req: Request): Promise<T> {
	return (await req.json()) as T;
}

export { fromBase64 };

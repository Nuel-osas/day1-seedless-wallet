// Shared by the browser app, the /api functions and the scripts.
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveObjectID, normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';

export const NETWORK = 'testnet' as const;
export const GRPC_URL = 'https://fullnode.testnet.sui.io:443';
export const EXPLORER = 'https://suiscan.xyz/testnet';

export const SUI_TYPE = '0x2::sui::SUI';
export const USDC_TYPE =
	'0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
export const COINS = [
	{ symbol: 'SUI', type: SUI_TYPE, decimals: 9 },
	{ symbol: 'USDC', type: USDC_TYPE, decimals: 6 },
] as const;

// sui::address_alias. AddressAliasState is the system singleton at 0xa.
export const ALIAS_STATE_ID = normalizeSuiAddress('0xa');
export const ALIAS_KEY_TYPE = '0x2::address_alias::AliasKey';
export const MAX_ALIASES = 8;

export function makeClient() {
	return new SuiGrpcClient({ network: NETWORK, baseUrl: GRPC_URL });
}

// AddressAliases is a derived object: its id is a pure function of (0xa, AliasKey(owner)).
// Anyone can compute it for any address without an index.
export function aliasesObjectId(owner: string) {
	return deriveObjectID(
		ALIAS_STATE_ID,
		ALIAS_KEY_TYPE,
		bcs.Address.serialize(normalizeSuiAddress(owner)).toBytes(),
	);
}

const AddressAliasesBcs = bcs.struct('AddressAliases', {
	id: bcs.Address,
	aliases: bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) }),
});

export type AliasState =
	| { enabled: false; objectId: string; aliases: string[] }
	| { enabled: true; objectId: string; aliases: string[]; version: string };

// Same lookup the validator does in get_address_aliases_from_store: no object means the
// address is only its own key; an object means ONLY the listed addresses may sign.
export async function readAliasState(client: SuiGrpcClient, owner: string): Promise<AliasState> {
	const objectId = aliasesObjectId(owner);
	try {
		const { object } = await client.core.getObject({ objectId, include: { content: true } });
		const parsed = AddressAliasesBcs.parse(object.content!);
		return { enabled: true, objectId, aliases: parsed.aliases.contents, version: object.version };
	} catch (e) {
		if (String(e).match(/not found|NotFound|does not exist/i)) {
			return { enabled: false, objectId, aliases: [normalizeSuiAddress(owner)] };
		}
		throw e;
	}
}

// Alias calls are `entry fun` (not public): only a top-level MoveCall in a PTB can reach
// them, never another Move module, and their arguments cannot be results of
// non-entry calls. Each helper below is one top-level command.
export function aliasEnable(tx: Transaction) {
	tx.moveCall({ target: '0x2::address_alias::enable', arguments: [tx.object(ALIAS_STATE_ID)] });
}
export function aliasAdd(tx: Transaction, aliasesId: string, alias: string) {
	tx.moveCall({
		target: '0x2::address_alias::add',
		arguments: [tx.object(aliasesId), tx.pure.address(alias)],
	});
}
export function aliasRemove(tx: Transaction, aliasesId: string, alias: string) {
	tx.moveCall({
		target: '0x2::address_alias::remove',
		arguments: [tx.object(aliasesId), tx.pure.address(alias)],
	});
}
export function aliasReplaceAll(tx: Transaction, aliasesId: string, aliases: string[]) {
	tx.moveCall({
		target: '0x2::address_alias::replace_all',
		arguments: [tx.object(aliasesId), tx.pure.vector('address', aliases)],
	});
}

// Send from the sender's funds. useGasCoin: false because the gas belongs to the sponsor.
export function sendFunds(tx: Transaction, coinType: string, amount: bigint, to: string) {
	tx.moveCall({
		target: '0x2::balance::send_funds',
		typeArguments: [coinType],
		arguments: [tx.balance({ balance: amount, type: coinType, useGasCoin: false }), tx.pure.address(to)],
	});
}

export function toUnits(amount: string, decimals: number): bigint {
	const [w, f = ''] = amount.trim().split('.');
	if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) throw new Error('bad amount');
	return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
export function fromUnits(units: string | bigint, decimals: number, dp = 4): string {
	const v = BigInt(units);
	const whole = v / 10n ** BigInt(decimals);
	const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, dp);
	return `${whole}.${frac}`.replace(/\.?0+$/, '') || '0';
}

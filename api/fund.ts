// Demo faucet: POST { address, coin } -> the sponsor sends a small amount into the address
// balance. Refuses if the account already holds that much, so it cannot be drained in a loop.
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { client, getSponsor, json, readJson } from './_lib/server.js';
import { COINS, sendFunds } from '../src/shared/sui.js';

const AMOUNTS: Record<string, bigint> = { SUI: 50_000_000n, USDC: 250_000n }; // 0.05 SUI, 0.25 USDC

export async function POST(req: Request) {
	try {
		const { address, coin } = await readJson<{ address: string; coin: 'SUI' | 'USDC' }>(req);
		if (!isValidSuiAddress(normalizeSuiAddress(address))) throw new Error('bad address');
		const c = COINS.find((c) => c.symbol === coin);
		if (!c) throw new Error('unknown coin');
		const amount = AMOUNTS[coin];
		const { balance } = await client.core.getBalance({ owner: address, coinType: c.type });
		if (BigInt(balance.balance) >= amount) throw new Error(`already has ${coin}, faucet only tops up empty accounts`);

		const sponsor = getSponsor();
		const tx = new Transaction();
		tx.setSender(sponsor.toSuiAddress());
		sendFunds(tx, c.type, amount, address);
		const result = await client.core.signAndExecuteTransaction({ transaction: tx, signer: sponsor, include: { effects: true } });
		const t = result.Transaction ?? result.FailedTransaction!;
		await client.core.waitForTransaction({ digest: t.digest }).catch(() => {});
		return json({ digest: t.digest, ok: t.status.success });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
}

// "What am I signing?" POST { txBytes } -> simulate, summarise the decoded commands and the
// simulated balance changes, ask DeepSeek for two plain sentences. Runs before the passkey prompt.
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { client, fromBase64, json, readJson } from './_lib/server.js';
import { COINS, fromUnits } from '../src/shared/sui.js';

function coinLabel(type: string) {
	const c = COINS.find((c) => normalizeStructTag(c.type) === normalizeStructTag(type));
	return c ?? { symbol: type.split('::').pop() ?? type, decimals: 0 };
}
function normalizeStructTag(t: string) {
	const [a, ...rest] = t.split('::');
	return [normalizeSuiAddress(a), ...rest].join('::');
}

type SimTx = { status: { success: boolean; error: unknown }; balanceChanges?: { coinType: string; address: string; amount: string }[] };

export function describe(txBytes: Uint8Array, sim: { Transaction?: SimTx; FailedTransaction?: SimTx } | null) {
	const data = Transaction.from(txBytes).getData();
	const pure = (i: number) => {
		const input = data.inputs[i];
		return input?.$kind === 'Pure' ? input.Pure.bytes : undefined;
	};
	const commands = data.commands.map((c) => {
		if (c.$kind !== 'MoveCall') return c.$kind;
		const args = c.MoveCall.arguments.map((a) => {
			if (a.$kind !== 'Input') return a.$kind;
			const input = data.inputs[a.Input];
			if (input.$kind === 'Pure') {
				const b = fromBase64(pure(a.Input)!);
				return b.length === 32 ? '0x' + Buffer.from(b).toString('hex') : `pure(${b.length} bytes)`;
			}
			if (input.$kind === 'Object') return 'object';
			if (input.$kind === 'FundsWithdrawal') return 'withdrawal from sender balance';
			return input.$kind;
		});
		const ty = (c.MoveCall.typeArguments ?? []).map((t) => coinLabel(t).symbol);
		return `${c.MoveCall.module}::${c.MoveCall.function}${ty.length ? `<${ty.join(',')}>` : ''}(${args.join(', ')})`;
	});
	const tx = sim?.Transaction ?? sim?.FailedTransaction;
	const changes = (tx?.balanceChanges ?? []).map((b) => {
		const c = coinLabel(b.coinType);
		const sign = b.amount.startsWith('-') ? '-' : '+';
		return `${b.address}: ${sign}${fromUnits(b.amount.replace('-', ''), c.decimals, 6)} ${c.symbol}`;
	});
	return {
		sender: data.sender,
		gasOwner: data.gasData.owner,
		sponsored: !!data.gasData.owner && data.gasData.owner !== data.sender,
		commands,
		balanceChanges: changes,
		simulation: tx ? (tx.status.success ? 'success' : `fails: ${JSON.stringify(tx.status.error)}`) : 'not run',
	};
}

export async function POST(req: Request) {
	try {
		const { txBytes, signerAddress } = await readJson<{ txBytes: string; signerAddress?: string }>(req);
		const bytes = fromBase64(txBytes);
		const sim = await client.core
			.simulateTransaction({ transaction: bytes, include: { balanceChanges: true, effects: true } })
			.catch(() => null);
		const facts = { ...describe(bytes, sim), signer: signerAddress ?? null };

		let preview: string | null = null;
		const key = process.env.DEEPSEEK_API_KEY;
		if (key) {
			const r = await fetch('https://api.deepseek.com/chat/completions', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: 'deepseek-flash',
					temperature: 0.2,
					max_tokens: 200,
					// deepseek-flash thinks by default and the reasoning tokens count against max_tokens,
					// which returned empty content. A two-sentence preview does not need it.
					thinking: { type: 'disabled' },
					messages: [
						{
							role: 'system',
							content:
								'You explain a Sui blockchain transaction to a non-technical wallet user before they approve it with Face ID. ' +
								'Reply with exactly two short sentences of plain English. Sentence one: what moves or changes, with amounts and shortened addresses (first 6 and last 4 hex chars). ' +
								'Sentence two: who pays the gas and anything risky, such as giving another key control of the account (address_alias add or replace_all) or removing a key (address_alias remove). ' +
								'address_alias enable on its own only creates the key list with the account as its only member and gives no other key control. ' +
								'Only use the facts given. No markdown.',
						},
						{ role: 'user', content: JSON.stringify(facts) },
					],
				}),
			});
			if (r.ok) {
				const out = (await r.json()) as { choices?: { message?: { content?: string } }[] };
				preview = out.choices?.[0]?.message?.content?.trim() ?? null;
			}
		}
		return json({ preview, facts });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
}

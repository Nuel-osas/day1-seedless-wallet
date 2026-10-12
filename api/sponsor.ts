// POST { txBytes, signature } -> sponsor checks policy, co-signs, executes.
// The user signs first: with address-balance gas there are no gas coins to pick, so the
// bytes are final before the sponsor ever sees them.
import { checkSponsorable, client, fromBase64, getSponsor, json, readJson } from './_lib/server.js';

export async function POST(req: Request) {
	try {
		const { txBytes, signature } = await readJson<{ txBytes: string; signature: string }>(req);
		const bytes = fromBase64(txBytes);
		await checkSponsorable(bytes);
		const { signature: sponsorSignature } = await getSponsor().signTransaction(bytes);
		const result = await client.core.executeTransaction({
			transaction: bytes,
			signatures: [signature, sponsorSignature],
			include: { effects: true, balanceChanges: true },
		});
		const tx = result.Transaction ?? result.FailedTransaction!;
		await client.core.waitForTransaction({ digest: tx.digest }).catch(() => {});
		return json({
			digest: tx.digest,
			ok: tx.status.success,
			error: tx.status.success ? null : tx.status.error,
			balanceChanges: tx.balanceChanges,
		});
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, 400);
	}
}

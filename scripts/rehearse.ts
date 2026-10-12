// Full lifecycle on testnet with software passkeys, through the same /api handlers the app uses.
//   pnpm rehearse
// 1 create passkey A (account X)   2 recover A's public key from two signatures
// 3 fund X, sponsored send signed by A   4 enable aliases + add recovery passkey B
// 5 "lose" A: B signs AS X   6 rotate: add new passkey C, remove X (A) in one PTB
// 7 A is now refused, C signs as X; address and balance unchanged
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { findCommonPublicKey, PasskeyKeypair } from '@mysten/sui/keypairs/passkey';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { SoftPasskeyProvider } from './soft-passkey.js';
import { aliasAdd, aliasEnable, aliasRemove, makeClient, readAliasState, sendFunds, SUI_TYPE } from '../src/shared/sui.js';
import { GET as config } from '../api/config.js';
import { POST as sponsor } from '../api/sponsor.js';
import { POST as explain } from '../api/explain.js';
import { POST as fund } from '../api/fund.js';

const client = makeClient();
const post = (h: (r: Request) => Promise<Response>, body: unknown) =>
	h(new Request('http://x', { method: 'POST', body: JSON.stringify(body) })).then((r) => r.json());
const log: Record<string, string> = {};

const { sponsor: SPONSOR } = await (await config()).json();

async function run(label: string, account: string, signer: Signer, build: (tx: Transaction) => void, expectFail = false) {
	const tx = new Transaction();
	tx.setSender(account);
	tx.setGasOwner(SPONSOR);
	tx.setGasPayment([]);
	build(tx);
	const bytes = await tx.build({ client });
	const preview = await post(explain, { txBytes: toBase64(bytes), signerAddress: signer.toSuiAddress() });
	console.log(`\n[${label}] preview: ${preview.preview ?? '(no DeepSeek key)'}`);
	const { signature } = await signer.signTransaction(bytes);
	const out = await post(sponsor, { txBytes: toBase64(bytes), signature });
	if (expectFail) {
		console.log(`[${label}] refused as expected: ${out.error ?? JSON.stringify(out)}`.slice(0, 300));
		if (out.digest && out.ok) throw new Error('expected failure');
		return;
	}
	if (!out.ok) throw new Error(`${label} failed: ${JSON.stringify(out)}`);
	console.log(`[${label}] ${out.digest}`);
	log[label] = out.digest;
}

// 1. create passkey A
const provA = new SoftPasskeyProvider();
const A = await PasskeyKeypair.getPasskeyInstance(provA);
const X = A.toSuiAddress();
console.log('account X (passkey A):', X);

// 2. returning sign-in: two signatures -> unique public key
const pk1 = await PasskeyKeypair.signAndRecover(provA, new TextEncoder().encode('Face ID Wallet sign-in 1'));
const pk2 = await PasskeyKeypair.signAndRecover(provA, new TextEncoder().encode('Face ID Wallet sign-in 2'));
const recovered = findCommonPublicKey(pk1, pk2);
if (recovered.toSuiAddress() !== X) throw new Error('recovery mismatch');
console.log('recovered public key from two signatures ->', recovered.toSuiAddress() === X ? 'same address' : 'MISMATCH');

// 3. fund + first sponsored send. X holds zero SUI for gas: sponsor pays from its address balance.
const f = await post(fund, { address: X, coin: 'SUI' });
console.log('funded X with 0.05 SUI:', f.digest ?? f.error);
log.fund = f.digest;
await run('first-send-sponsored', X, A, (tx) => sendFunds(tx, SUI_TYPE, 1_000_000n, SPONSOR));

// 4. recovery alias: enable, then add passkey B. Two transactions: enable party-transfers the
// AddressAliases object, so the same PTB cannot get a reference to it.
const provB = new SoftPasskeyProvider();
const B = await PasskeyKeypair.getPasskeyInstance(provB);
console.log('recovery passkey B address:', B.toSuiAddress());
await run('alias-enable', X, A, (tx) => aliasEnable(tx));
let state = await readAliasState(client, X);
console.log('alias state after enable:', state);
await run('alias-add-recovery', X, A, (tx) => aliasAdd(tx, state.objectId, B.toSuiAddress()));
state = await readAliasState(client, X);
console.log('alias state after add:', state.aliases);

// 5. lose A. B signs a transaction whose sender is X.
const before = (await client.core.getBalance({ owner: X })).balance.balance;
await run('send-as-X-signed-by-B', X, B, (tx) => sendFunds(tx, SUI_TYPE, 1_000_000n, SPONSOR));

// 6. rotate: new passkey C, add C and remove X's own key in one PTB (two top-level commands)
const provC = new SoftPasskeyProvider();
const C = await PasskeyKeypair.getPasskeyInstance(provC);
console.log('new passkey C address:', C.toSuiAddress());
await run('rotate-add-C-remove-A', X, B, (tx) => {
	aliasAdd(tx, state.objectId, C.toSuiAddress());
	aliasRemove(tx, state.objectId, X);
});
state = await readAliasState(client, X);
console.log('alias state after rotation:', state.aliases);

// 7. the lost key is refused at signature verification; C works as X
await run('old-passkey-A-refused', X, A, (tx) => sendFunds(tx, SUI_TYPE, 1_000_000n, SPONSOR), true);
await run('send-as-X-signed-by-C', X, C, (tx) => sendFunds(tx, SUI_TYPE, 1_000_000n, SPONSOR));
const after = (await client.core.getBalance({ owner: X })).balance.balance;
console.log(`\nX = ${X}\nbalance before recovery ${before}, after rotation ${after} (two 0.001 SUI sends, zero gas)`);

writeFileSync(new URL('./.rehearsal.json', import.meta.url), JSON.stringify({ X, B: B.toSuiAddress(), C: C.toSuiAddress(), aliasesObject: state.objectId, digests: log }, null, 2));
console.log(JSON.stringify(log, null, 2));

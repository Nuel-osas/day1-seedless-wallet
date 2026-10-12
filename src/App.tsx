import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import {
	aliasAdd, aliasEnable, aliasRemove, COINS, EXPLORER, fromUnits, readAliasState, sendFunds, toUnits,
	type AliasState,
} from './shared/sui';
import { createPasskey, passkeySigner, recoverPasskey, type StoredPasskey } from './lib/passkey';
import { approve, client, fund, getConfig, prepare, storage, type Preview, type WalletState } from './lib/wallet';

const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`;
const txLink = (d: string) => `${EXPLORER}/tx/${d}`;
const acctLink = (a: string) => `${EXPLORER}/account/${a}`;

type Pending = { title: string; bytes: Uint8Array; preview: Preview; done: (digest: string) => void };
type Log = { label: string; digest: string };

export default function App() {
	const [wallet, setWallet] = useState<WalletState | null>(storage.load());
	const [guardian, setGuardian] = useState<Ed25519Keypair | null>(null);
	const [sponsor, setSponsor] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const [log, setLog] = useState<Log[]>([]);

	useEffect(() => {
		getConfig().then((c) => setSponsor(c.sponsor)).catch((e) => setError(String(e)));
	}, []);

	const signer: Signer | null = useMemo(() => {
		if (!wallet) return null;
		if (wallet.signer.kind === 'passkey') return passkeySigner(wallet.signer);
		return guardian;
	}, [wallet, guardian]);

	const use = (w: WalletState | null) => {
		if (w) storage.save(w);
		else storage.clear();
		setWallet(w);
	};

	const guard = useCallback(async (label: string, fn: () => Promise<void>) => {
		setBusy(label);
		setError(null);
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, []);

	// Every transaction goes build -> preview -> (user approves) -> passkey prompt -> sponsor.
	const submit = (title: string, build: (tx: Transaction) => void, done: (d: string) => void = () => {}) =>
		guard(`Preparing: ${title}`, async () => {
			if (!wallet || !signer) throw new Error('no signer');
			const { bytes, preview } = await prepare(wallet.account, signer.toSuiAddress(), build);
			setPending({ title, bytes, preview, done });
		});

	const onApprove = () =>
		guard('Waiting for your passkey', async () => {
			const p = pending!;
			setPending(null);
			const digest = await approve(p.bytes, signer!);
			setLog((l) => [{ label: p.title, digest }, ...l]);
			p.done(digest);
		});

	return (
		<div className="page">
			<header>
				<div className="brand"><img src="/favicon.svg" alt="" /> Face ID Wallet</div>
				<span className="pill">Sui testnet</span>
			</header>
			{error && <div className="error" data-testid="error">{error}</div>}
			{busy && <div className="busy" data-testid="busy">{busy}...</div>}

			{!wallet ? (
				<Onboarding guard={guard} use={use} setGuardian={setGuardian} />
			) : (
				<WalletView
					wallet={wallet}
					sponsor={sponsor}
					signerReady={!!signer}
					submit={submit}
					guard={guard}
					use={use}
					setGuardian={setGuardian}
					log={log}
					setLog={setLog}
				/>
			)}

			<AliasLookup />

			{pending && (
				<div className="modal-bg">
					<div className="modal" data-testid="review">
						<h3>What am I signing?</h3>
						<p className="preview" data-testid="preview">{pending.preview.preview ?? 'No AI preview (DEEPSEEK_API_KEY not set). Decoded facts below.'}</p>
						<details open>
							<summary>Decoded from the transaction and its simulation</summary>
							<ul className="facts">
								{pending.preview.facts.commands.map((c, i) => <li key={i}><code>{c}</code></li>)}
								{pending.preview.facts.balanceChanges.map((c, i) => <li key={`b${i}`}>{c}</li>)}
								<li>Gas paid by sponsor {short(pending.preview.facts.gasOwner)}. Simulation: {pending.preview.facts.simulation}</li>
							</ul>
						</details>
						<p className="hint">The next prompt comes from your operating system, not from this page. It will say "{location.hostname}".</p>
						<div className="row">
							<button className="ghost" onClick={() => setPending(null)}>Cancel</button>
							<button data-testid="approve" onClick={onApprove}>Approve with passkey</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

type Guard = (label: string, fn: () => Promise<void>) => Promise<void>;

function Onboarding({ guard, use, setGuardian }: { guard: Guard; use: (w: WalletState) => void; setGuardian: (k: Ed25519Keypair) => void }) {
	const [recoverAccount, setRecoverAccount] = useState(storage.lastAccount());
	const [guardianSecret, setGuardianSecret] = useState('');
	const [deviceKey, setDeviceKey] = useState<StoredPasskey | null>(null);

	const recoverWithPasskey = () =>
		guard('Recovering with passkey', async () => {
			const account = normalizeSuiAddress(recoverAccount);
			const state = await readAliasState(client, account);
			// Prefer a passkey whose public key this device already knows (one prompt per signature).
			const known = storage.deviceKeys().find((k) => state.aliases.includes(k.address));
			const key = known ?? (await recoverPasskey('Face ID Wallet recovery'));
			if (!state.aliases.includes(key.address))
				throw new Error(`Passkey ${short(key.address)} is not an alias of ${short(account)}. Aliases: ${state.aliases.map(short).join(', ')}`);
			use({ account, signer: key });
		});

	const recoverWithGuardian = () =>
		guard('Recovering with guardian key', async () => {
			const account = normalizeSuiAddress(recoverAccount);
			const kp = Ed25519Keypair.fromSecretKey(guardianSecret.trim());
			const state = await readAliasState(client, account);
			if (!state.aliases.includes(kp.toSuiAddress())) throw new Error('That guardian key is not an alias of this account');
			setGuardian(kp);
			use({ account, signer: { kind: 'guardian', label: 'Guardian key', address: kp.toSuiAddress() } });
		});

	return (
		<>
			<section className="card hero">
				<h1>A wallet with no seed phrase.</h1>
				<p>Your key is a passkey in this device's secure hardware. Gas is sponsored, so a new account can send with zero SUI.</p>
				<div className="row">
					<button data-testid="create" onClick={() => guard('Creating passkey', async () => {
						const k = await createPasskey('Face ID Wallet');
						use({ account: k.address, signer: k });
					})}>Create wallet with passkey</button>
					<button className="ghost" data-testid="signin" onClick={() => guard('Signing in (two prompts)', async () => {
						const k = await recoverPasskey('Face ID Wallet');
						use({ account: k.address, signer: k });
					})}>Sign in with existing passkey</button>
				</div>
				<p className="hint">Signing in on a device that has not stored your public key takes two passkey prompts: the SDK recovers the key from two signatures.</p>
			</section>

			<section className="card">
				<h2>Use this device as a recovery key</h2>
				<p>Creates a passkey here and shows its address. Add that address as an alias from your main device.</p>
				<button className="ghost" data-testid="recovery-device" onClick={() => guard('Creating recovery passkey', async () => {
					const k = await createPasskey('Face ID Wallet recovery');
					storage.rememberDeviceKey(k);
					setDeviceKey(k);
				})}>Create recovery passkey</button>
				{deviceKey && <p>Recovery address: <code data-testid="recovery-device-address">{deviceKey.address}</code></p>}
			</section>

			<section className="card">
				<h2>Recover an account</h2>
				<label>Account address<input data-testid="recover-account" value={recoverAccount} onChange={(e) => setRecoverAccount(e.target.value)} placeholder="0x..." /></label>
				<div className="row">
					<button data-testid="recover-passkey" disabled={!isValidSuiAddress(normalizeSuiAddress(recoverAccount || '0x0')) || !recoverAccount} onClick={recoverWithPasskey}>Recover with a recovery passkey</button>
				</div>
				<label>Or a guardian key<input type="password" value={guardianSecret} onChange={(e) => setGuardianSecret(e.target.value)} placeholder="suiprivkey1..." /></label>
				<button className="ghost" disabled={!guardianSecret || !recoverAccount} onClick={recoverWithGuardian}>Recover with guardian key</button>
			</section>
		</>
	);
}

function WalletView(props: {
	wallet: WalletState; sponsor: string; signerReady: boolean; log: Log[];
	submit: (title: string, build: (tx: Transaction) => void, done?: (d: string) => void) => Promise<void>;
	guard: Guard; use: (w: WalletState | null) => void; setGuardian: (k: Ed25519Keypair) => void;
	setLog: React.Dispatch<React.SetStateAction<Log[]>>;
}) {
	const { wallet, submit, guard, use, setLog } = props;
	const [balances, setBalances] = useState<Record<string, string>>({});
	const [aliases, setAliases] = useState<AliasState | null>(null);
	const [coin, setCoin] = useState<'SUI' | 'USDC'>('SUI');
	const [amount, setAmount] = useState('0.001');
	const [to, setTo] = useState('');
	const [newAlias, setNewAlias] = useState('');
	const [shownSecret, setShownSecret] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const { balances } = await client.core.listBalances({ owner: wallet.account });
		const out: Record<string, string> = {};
		for (const c of COINS) {
			const b = balances.find((b) => normalizeStructTag(b.coinType) === normalizeStructTag(c.type));
			out[c.symbol] = fromUnits(b?.balance ?? '0', c.decimals);
		}
		setBalances(out);
		setAliases(await readAliasState(client, wallet.account));
	}, [wallet.account]);
	useEffect(() => { refresh().catch(() => {}); }, [refresh]);

	const after = (fn?: () => void) => (_: string) => { fn?.(); setTimeout(() => refresh().catch(() => {}), 1200); };
	const isAlias = wallet.signer.address !== wallet.account;
	const enabled = aliases?.enabled;

	const addAlias = (address: string, title: string) => {
		if (!aliases?.enabled) throw new Error('Turn on recovery first');
		return submit(title, (tx) => aliasAdd(tx, aliases.objectId, address), after());
	};

	return (
		<>
			<section className="card">
				<div className="row between">
					<div>
						<div className="label">Account</div>
						<a className="addr" data-testid="account" href={acctLink(wallet.account)} target="_blank">{wallet.account}</a>
					</div>
					<button className="ghost small" onClick={() => navigator.clipboard.writeText(wallet.account)}>Copy</button>
				</div>
				<div className="signer" data-testid="signer">
					Signing with {wallet.signer.label} <code>{short(wallet.signer.address)}</code>
					{isAlias && <span className="tag">alias: signing as {short(wallet.account)}</span>}
					{!props.signerReady && <span className="tag warn">guardian key not loaded</span>}
				</div>
				<div className="balances">
					{COINS.map((c) => (
						<div key={c.symbol} className="bal">
							<span data-testid={`bal-${c.symbol}`}>{balances[c.symbol] ?? '...'}</span> {c.symbol}
						</div>
					))}
				</div>
				<div className="row">
					<button className="ghost small" data-testid="fund-sui" onClick={() => guard('Funding', async () => { const r = await fund(wallet.account, 'SUI'); setLog((l) => [{ label: 'Demo faucet: 0.05 SUI', digest: r.digest }, ...l]); after()(r.digest); })}>Get 0.05 test SUI</button>
					<button className="ghost small" onClick={() => guard('Funding', async () => { const r = await fund(wallet.account, 'USDC'); setLog((l) => [{ label: 'Demo faucet: 0.25 USDC', digest: r.digest }, ...l]); after()(r.digest); })}>Get 0.25 test USDC</button>
					<a className="small" href="https://faucet.circle.com/" target="_blank">Circle USDC faucet (pick Sui Testnet)</a>
					<button className="ghost small" onClick={() => refresh()}>Refresh</button>
				</div>
				<p className="hint">This account never needs SUI for gas. Every transaction below is co-signed by the sponsor {short(props.sponsor || '0x')} and paid from its address balance.</p>
			</section>

			<section className="card">
				<h2>Send</h2>
				<div className="row">
					<select value={coin} onChange={(e) => setCoin(e.target.value as 'SUI' | 'USDC')}>{COINS.map((c) => <option key={c.symbol}>{c.symbol}</option>)}</select>
					<input data-testid="amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} />
					<input data-testid="to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient 0x..." className="grow" />
				</div>
				<button data-testid="send" disabled={!to} onClick={() => {
					const c = COINS.find((c) => c.symbol === coin)!;
					submit(`Send ${amount} ${coin}`, (tx) => sendFunds(tx, c.type, toUnits(amount, c.decimals), normalizeSuiAddress(to)), after());
				}}>Review and send</button>
			</section>

			<section className="card">
				<h2>Recovery and keys</h2>
				<p>Keys allowed to sign for this address (<code>sui::address_alias</code>):</p>
				<ul className="aliases" data-testid="aliases">
					{aliases?.aliases.map((a) => (
						<li key={a}>
							<code>{a}</code>
							{a === wallet.account && <span className="tag">account's own key</span>}
							{a === wallet.signer.address && <span className="tag">this session</span>}
							{enabled && aliases.aliases.length > 1 && (
								<button className="ghost small" onClick={() => submit(`Remove key ${short(a)}`, (tx) => aliasRemove(tx, aliases.objectId, a), after())}>Remove</button>
							)}
						</li>
					))}
				</ul>
				{!enabled ? (
					<button data-testid="enable" onClick={() => submit('Turn on recovery (address_alias::enable)', (tx) => aliasEnable(tx), after())}>Turn on recovery</button>
				) : (
					<>
						<div className="row">
							<button data-testid="add-recovery-passkey" onClick={() => guard('Creating recovery passkey', async () => {
								const k = await createPasskey('Face ID Wallet recovery');
								storage.rememberDeviceKey(k);
								await addAlias(k.address, 'Add recovery passkey');
							})}>Add recovery passkey</button>
							<button className="ghost" onClick={() => guard('Creating guardian key', async () => {
								const kp = Ed25519Keypair.generate();
								setShownSecret(kp.getSecretKey());
								await addAlias(kp.toSuiAddress(), 'Add guardian key');
							})}>Add guardian key</button>
						</div>
						{shownSecret && <p className="secret">Guardian secret, shown once. Give it to your guardian or store it offline: <code>{shownSecret}</code></p>}
						<div className="row">
							<input data-testid="new-alias" value={newAlias} onChange={(e) => setNewAlias(e.target.value)} placeholder="Recovery address from your second device, 0x..." className="grow" />
							<button className="ghost" data-testid="add-alias" disabled={!newAlias} onClick={() => guard('Adding alias', () => addAlias(normalizeSuiAddress(newAlias), `Add alias ${short(newAlias)}`))}>Add address</button>
						</div>
						<button data-testid="rotate" onClick={() => guard('Creating new passkey', async () => {
							const k = await createPasskey('Face ID Wallet');
							const removeOld = aliases.aliases.includes(wallet.account) && wallet.signer.address !== wallet.account;
							await submit(removeOld ? 'Rotate: add new passkey, remove the lost one' : 'Add new passkey', (tx) => {
								aliasAdd(tx, aliases.objectId, k.address);
								if (removeOld) aliasRemove(tx, aliases.objectId, wallet.account);
							}, after(() => use({ account: wallet.account, signer: k })));
						})}>Rotate to a new passkey</button>
						<p className="hint">Rotate adds a fresh passkey and, when you are signed in with a recovery key, removes the account's original key in the same transaction (two top-level commands).</p>
					</>
				)}
				<div className="row">
					<button className="danger" data-testid="lose" onClick={() => {
						if (wallet.signer.kind === 'passkey') storage.forgetDeviceKey(wallet.signer.address);
						use(null);
					}}>Simulate losing this device</button>
					<button className="ghost" onClick={() => use(null)}>Sign out</button>
				</div>
			</section>

			{props.log.length > 0 && (
				<section className="card">
					<h2>Activity</h2>
					<ul className="log" data-testid="log">
						{props.log.map((l) => <li key={l.digest}>{l.label}: <a href={txLink(l.digest)} target="_blank" data-testid="digest">{l.digest}</a></li>)}
					</ul>
				</section>
			)}
		</>
	);
}

function AliasLookup() {
	const [addr, setAddr] = useState('');
	const [state, setState] = useState<AliasState | null>(null);
	const [err, setErr] = useState<string | null>(null);
	return (
		<section className="card">
			<h2>Alias state for any address</h2>
			<p className="hint">The AddressAliases object id is derived from (0xa, AliasKey(address)), so no indexer is needed.</p>
			<div className="row">
				<input data-testid="lookup" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x..." className="grow" />
				<button className="ghost" data-testid="lookup-go" onClick={async () => {
					setErr(null);
					try { setState(await readAliasState(client, normalizeSuiAddress(addr))); } catch (e) { setErr(String(e)); }
				}}>Look up</button>
			</div>
			{err && <p className="error">{err}</p>}
			{state && (
				<div data-testid="lookup-result">
					<p>{state.enabled ? `Aliases enabled. Object ${short(state.objectId)}.` : `No AddressAliases object (${short(state.objectId)} does not exist): only the address's own key can sign.`}</p>
					<ul className="aliases">{state.aliases.map((a) => <li key={a}><code>{a}</code></li>)}</ul>
				</div>
			)}
		</section>
	);
}

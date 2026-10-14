import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import {
	aliasAdd, aliasEnable, aliasRemove, COINS, EXPLORER, fromUnits, MAX_ALIASES, readAliasState, sendFunds, toUnits,
	type AliasState,
} from './shared/sui';
import { createPasskey, passkeySigner, recoverPasskey, type StoredPasskey } from './lib/passkey';
import { approve, client, fund, getConfig, prepare, storage, type Preview, type WalletState } from './lib/wallet';

const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`;
const txLink = (d: string) => `${EXPLORER}/tx/${d}`;
const acctLink = (a: string) => `${EXPLORER}/account/${a}`;
const REPO = 'https://github.com/Nuel-osas/day1-seedless-wallet';

// The SDK's errors are accurate but long. Lead with what to do, keep the raw text after it.
function friendly(msg: string) {
	if (/Insufficient balance/i.test(msg)) return `Not enough balance for that send. Use the test faucet buttons on the account card, then try again. (${msg})`;
	if (/NotAllowedError|timed out or was not allowed/i.test(msg)) return 'The passkey prompt was cancelled or timed out. Nothing was signed.';
	return msg;
}

type Pending = { title: string; bytes: Uint8Array; preview: Preview; done: (digest: string) => void };
type Log = { label: string; digest: string };

const Icon = {
	face: (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 10v1M15 10v1M12 10v4h-1M9 16.5c1.7 1.3 4.3 1.3 6 0" /></svg>
	),
	key: (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3M17 6l3 3M15 8l2 2" /></svg>
	),
	phone: (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>
	),
	lock: (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></svg>
	),
};

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
			setError(friendly(e instanceof Error ? e.message : String(e)));
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
			<header className="top">
				<div className="brand"><img src="/favicon.svg" alt="" /> Face ID Wallet</div>
				<span className="net"><span className="dot" /> Sui testnet</span>
			</header>

			{error && (
				<div className="banner" data-testid="error">
					<div><span className="eyebrow">[ Something failed ]</span>{error}</div>
					<button className="icon" aria-label="Dismiss" onClick={() => setError(null)}>Dismiss</button>
				</div>
			)}

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

			<footer className="foot">
				<span>SuiHub Lagos · Day 1 · passkey_auth + address_aliases</span>
				<span>
					{sponsor && <>Sponsor <a href={acctLink(sponsor)} target="_blank">{short(sponsor)}</a> · </>}
					<a href={REPO} target="_blank">Source</a>
				</span>
			</footer>

			{busy && <div className="toast" data-testid="busy"><span className="spin" />{busy}...</div>}

			{pending && (
				<div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setPending(null)}>
					<div className="modal" data-testid="review" role="dialog" aria-modal="true">
						<span className="eyebrow">[ Review before you sign ]</span>
						<h3>{pending.title}</h3>
						<p className="preview" data-testid="preview">{pending.preview.preview ?? 'No AI preview (DEEPSEEK_API_KEY not set). Decoded facts below.'}</p>
						<details className="facts" open>
							<summary>Decoded from the transaction</summary>
							<ul>
								{pending.preview.facts.commands.map((c, i) => <li key={i}><code>{c}</code></li>)}
								{pending.preview.facts.balanceChanges.map((c, i) => <li key={`b${i}`}>{c}</li>)}
								<li>Gas paid by sponsor <code className="inl">{short(pending.preview.facts.gasOwner)}</code></li>
								<li>Simulation: {pending.preview.facts.simulation}</li>
							</ul>
						</details>
						<div className="os">{Icon.lock}<span>The next prompt comes from your operating system, not this page. It will name <b>{location.hostname}</b>.</span></div>
						<div className="row end modal-actions">
							<button className="ghost" onClick={() => setPending(null)}>Cancel</button>
							<button data-testid="approve" onClick={onApprove}>{Icon.face} Approve with passkey</button>
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
	const validAccount = !!recoverAccount && isValidSuiAddress(normalizeSuiAddress(recoverAccount || '0x0'));

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
		<div className="grid">
			<section className="card hero full">
				<span className="eyebrow">[ Seedless wallet ]</span>
				<h1 className="headline mt">No seed phrase.<span className="soft">No gas. No lost accounts.</span></h1>
				<p className="lede">Your key is a passkey in this device's secure hardware. A sponsor pays gas, so a new account can send before it holds any SUI.</p>
				<div className="hero-actions">
					<button className="lg" data-testid="create" onClick={() => guard('Creating passkey', async () => {
						const k = await createPasskey('Face ID Wallet');
						use({ account: k.address, signer: k });
					})}>{Icon.face} Create wallet with passkey</button>
					<button className="lg ghost" data-testid="signin" onClick={() => guard('Signing in (two prompts)', async () => {
						const k = await recoverPasskey('Face ID Wallet');
						use({ account: k.address, signer: k });
					})}>Sign in with existing passkey</button>
				</div>
				<p className="hint mt">Signing in on a device that has not stored your public key takes two passkey prompts: the SDK recovers the key from two signatures.</p>
				<div className="steps">
					<div><span className="n">01</span><h3>Passkey</h3><p>Touch ID, Face ID or Windows Hello signs. Nothing to write down.</p></div>
					<div><span className="n">02</span><h3>Sponsored gas</h3><p>Paid from the sponsor's address balance. Zero SUI needed.</p></div>
					<div><span className="n">03</span><h3>Aliases</h3><p>Add a backup key. Rotate a lost one. The address never changes.</p></div>
				</div>
			</section>

			<section className="card">
				<span className="eyebrow">[ Second device ]</span>
				<h2>Use this device as a recovery key</h2>
				<p className="lede">Creates a passkey here and shows its address. Add that address as an alias from your main device.</p>
				<div className="row mt">
					<button className="ghost" data-testid="recovery-device" onClick={() => guard('Creating recovery passkey', async () => {
						const k = await createPasskey('Face ID Wallet recovery');
						storage.rememberDeviceKey(k);
						setDeviceKey(k);
					})}>{Icon.phone} Create recovery passkey</button>
				</div>
				{deviceKey && (
					<div className="field">
						<span>Recovery address</span>
						<div className="inline">
							<code data-testid="recovery-device-address" style={{ padding: '12px 14px', flex: 1 }}>{deviceKey.address}</code>
							<CopyButton text={deviceKey.address} />
						</div>
					</div>
				)}
			</section>

			<section className="card">
				<span className="eyebrow">[ Lost a device ]</span>
				<h2>Recover an account</h2>
				<label className="field"><span>Account address</span>
					<input className="mono" data-testid="recover-account" value={recoverAccount} onChange={(e) => setRecoverAccount(e.target.value)} placeholder="0x..." />
				</label>
				<div className="row mt-s">
					<button data-testid="recover-passkey" disabled={!validAccount} onClick={recoverWithPasskey}>{Icon.face} Recover with a recovery passkey</button>
				</div>
				<label className="field"><span>Or a guardian key</span>
					<div className="inline">
						<input className="mono" type="password" value={guardianSecret} onChange={(e) => setGuardianSecret(e.target.value)} placeholder="suiprivkey1..." />
						<button className="ghost" disabled={!guardianSecret || !recoverAccount} onClick={recoverWithGuardian}>Recover with guardian key</button>
					</div>
				</label>
			</section>

			<div className="full"><AliasLookup /></div>
		</div>
	);
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
	const [done, setDone] = useState(false);
	return (
		<button className="icon" onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); }}>
			{done ? 'Copied' : label}
		</button>
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
	const deviceKeys = storage.deviceKeys().map((k) => k.address);

	const addAlias = (address: string, title: string) => {
		if (!aliases?.enabled) throw new Error('Turn on recovery first');
		return submit(title, (tx) => aliasAdd(tx, aliases.objectId, address), after());
	};

	const progress = [
		{ label: 'Passkey created', done: true },
		{ label: 'First sponsored send', done: props.log.some((l) => l.label.startsWith('Send')) },
		{ label: 'Recovery on', done: !!enabled },
		{ label: 'Backup key added', done: (aliases?.aliases.length ?? 0) > 1 },
	];

	return (
		<div className="grid">
			<div className="stack">
				<section className="card balance">
					<div className="card-head" style={{ marginBottom: 0 }}>
						<span className="eyebrow">[ Account ]</span>
						<button className="icon" onClick={() => refresh()}>Refresh</button>
					</div>
					<div className="acct">
						<a data-testid="account" href={acctLink(wallet.account)} target="_blank" title={wallet.account}>{wallet.account}</a>
						<CopyButton text={wallet.account} />
					</div>
					<div className="bals">
						{COINS.map((c) => (
							<div key={c.symbol} className="bal">
								<div className="num" data-testid={`bal-${c.symbol}`}>{balances[c.symbol] ?? '...'}</div>
								<div className="sym">{c.symbol}</div>
							</div>
						))}
					</div>
					<div className="row mt">
						<button className="chip" data-testid="fund-sui" onClick={() => guard('Funding', async () => { const r = await fund(wallet.account, 'SUI'); setLog((l) => [{ label: 'Demo faucet: 0.05 SUI', digest: r.digest }, ...l]); after()(r.digest); })}>+ 0.05 test SUI</button>
						<button className="chip" onClick={() => guard('Funding', async () => { const r = await fund(wallet.account, 'USDC'); setLog((l) => [{ label: 'Demo faucet: 0.25 USDC', digest: r.digest }, ...l]); after()(r.digest); })}>+ 0.25 test USDC</button>
						<a className="chip" href="https://faucet.circle.com/" target="_blank">Circle USDC faucet</a>
					</div>
					<div className="signer" data-testid="signer">
						Signing with {wallet.signer.label} <code>{short(wallet.signer.address)}</code>
						{isAlias && <span className="tag">alias: signing as {short(wallet.account)}</span>}
						{!props.signerReady && <span className="tag warn">guardian key not loaded</span>}
					</div>
				</section>

				<section className="card">
					<div className="card-head">
						<span className="eyebrow">[ Send ]</span>
						<span className="tag good">Gas sponsored</span>
					</div>
					<div className="coin-toggle" role="radiogroup">
						{COINS.map((c) => (
							<button key={c.symbol} role="radio" aria-checked={coin === c.symbol} className={coin === c.symbol ? 'on' : ''} onClick={() => setCoin(c.symbol as 'SUI' | 'USDC')}>{c.symbol}</button>
						))}
					</div>
					<div className="amount">
						<input data-testid="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
						<span className="sym">{coin}</span>
					</div>
					<label className="field"><span>Recipient</span>
						<input className="mono" data-testid="to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x..." />
					</label>
					<div className="row mt">
						<button className="lg" data-testid="send" disabled={!to} onClick={() => {
							const c = COINS.find((c) => c.symbol === coin)!;
							submit(`Send ${amount} ${coin}`, (tx) => sendFunds(tx, c.type, toUnits(amount, c.decimals), normalizeSuiAddress(to)), after());
						}}>Review and send</button>
					</div>
					<p className="hint mt">This account never needs SUI for gas. The sponsor {short(props.sponsor || '0x')} co-signs every transaction and pays from its address balance.</p>
				</section>

				<section className="card">
					<div className="card-head" style={{ marginBottom: 14 }}>
						<span className="eyebrow">[ Activity ]</span>
						<span className="count">{props.log.length} this session</span>
					</div>
					{props.log.length > 0 ? (
						<ul className="log" data-testid="log">
							{props.log.map((l) => (
								<li key={l.digest}>
									<span className="pip" />
									<span className="what">{l.label}</span>
									<a href={txLink(l.digest)} target="_blank" data-testid="digest" title={l.digest}>{l.digest}</a>
								</li>
							))}
						</ul>
					) : (
						<p className="empty">Transactions you sign here show up with a link to the explorer.</p>
					)}
				</section>
			</div>

			<div className="stack">
				<section className="card">
					<span className="eyebrow">[ Today's run ]</span>
					<div className="progress mt">
						{progress.map((s, i) => (
							<div key={s.label} className={s.done ? 'done' : ''}>
								<span className="n">{String(i + 1).padStart(2, '0')}{s.done && <span className="check" aria-label="done"> ✓</span>}</span>
								<p>{s.label}</p>
							</div>
						))}
					</div>
				</section>

				<section className="card">
					<div className="card-head">
						<span className="eyebrow">[ Recovery and keys ]</span>
						{aliases && <span className="count">{aliases.aliases.length} / {MAX_ALIASES} keys</span>}
					</div>
					<p className="lede" style={{ marginTop: 0, marginBottom: 16 }}>Keys allowed to sign for this address, from <code>sui::address_alias</code>.</p>
					<ul className="keys" data-testid="aliases">
						{aliases?.aliases.map((a) => (
							<li key={a} className={a === wallet.signer.address ? 'me' : ''}>
								<span className="kicon">{deviceKeys.includes(a) || a === wallet.account ? Icon.face : Icon.key}</span>
								<div className="kbody">
									<code title={a}>{a}</code>
									<div className="tags">
										{a === wallet.account && <span className="tag plain">account's own key</span>}
										{a === wallet.signer.address && <span className="tag">this session</span>}
										{a !== wallet.account && a !== wallet.signer.address && <span className="tag plain">alias</span>}
									</div>
								</div>
								{enabled && aliases.aliases.length > 1 && (
									<button className="icon" onClick={() => submit(`Remove key ${short(a)}`, (tx) => aliasRemove(tx, aliases.objectId, a), after())}>Remove</button>
								)}
							</li>
						))}
						{!aliases && <li className="empty">Loading...</li>}
					</ul>

					{!enabled ? (
						<div className="mt">
							<p className="hint" style={{ marginBottom: 14 }}>Recovery is off: only the account's own passkey can sign. Turning it on creates an AddressAliases object for this address.</p>
							<button data-testid="enable" onClick={() => submit('Turn on recovery (address_alias::enable)', (tx) => aliasEnable(tx), after())}>Turn on recovery</button>
						</div>
					) : (
						<>
							<div className="row mt">
								<button data-testid="add-recovery-passkey" onClick={() => guard('Creating recovery passkey', async () => {
									const k = await createPasskey('Face ID Wallet recovery');
									storage.rememberDeviceKey(k);
									await addAlias(k.address, 'Add recovery passkey');
								})}>{Icon.face} Add recovery passkey</button>
								<button className="ghost" data-testid="add-phone-passkey" onClick={() => guard('Scan the QR code with your phone', async () => {
									const k = await createPasskey('Face ID Wallet phone', 'phone');
									storage.rememberDeviceKey(k);
									await addAlias(k.address, 'Add phone passkey (QR)');
								})}>{Icon.phone} Add passkey from my phone (QR)</button>
								<button className="ghost" onClick={() => guard('Creating guardian key', async () => {
									const kp = Ed25519Keypair.generate();
									setShownSecret(kp.getSecretKey());
									await addAlias(kp.toSuiAddress(), 'Add guardian key');
								})}>{Icon.key} Add guardian key</button>
							</div>
							<p className="hint mt-s">On a laptop, "Add recovery passkey" may save to this same computer. To survive losing this laptop, use the phone button: scan the QR, approve with Face ID, and the key lives on your phone.</p>
							{shownSecret && (
								<div className="secret">Guardian secret, shown once. Give it to your guardian or store it offline.<code>{shownSecret}</code></div>
							)}
							<label className="field"><span>Address from your second device</span>
								<div className="inline">
									<input className="mono" data-testid="new-alias" value={newAlias} onChange={(e) => setNewAlias(e.target.value)} placeholder="0x..." />
									<button className="ghost" data-testid="add-alias" disabled={!newAlias} onClick={() => guard('Adding alias', () => addAlias(normalizeSuiAddress(newAlias), `Add alias ${short(newAlias)}`))}>Add address</button>
								</div>
							</label>
							<hr className="divider" />
							<button data-testid="rotate" onClick={() => guard('Creating new passkey', async () => {
								const k = await createPasskey('Face ID Wallet');
								const removeOld = aliases.aliases.includes(wallet.account) && wallet.signer.address !== wallet.account;
								await submit(removeOld ? 'Rotate: add new passkey, remove the lost one' : 'Add new passkey', (tx) => {
									aliasAdd(tx, aliases.objectId, k.address);
									if (removeOld) aliasRemove(tx, aliases.objectId, wallet.account);
								}, after(() => use({ account: wallet.account, signer: k })));
							})}>Rotate to a new passkey</button>
							<p className="hint mt-s">Rotate adds a fresh passkey and, when you are signed in with a recovery key, removes the account's original key in the same transaction (two top-level commands).</p>
						</>
					)}
					<hr className="divider" />
					<div className="row">
						<button className="danger" data-testid="lose" onClick={() => {
							if (wallet.signer.kind === 'passkey') storage.forgetDeviceKey(wallet.signer.address);
							use(null);
						}}>Simulate losing this device</button>
						<button className="ghost" onClick={() => use(null)}>Sign out</button>
					</div>
				</section>

				<AliasLookup />
			</div>
		</div>
	);
}

function AliasLookup() {
	const [addr, setAddr] = useState('');
	const [state, setState] = useState<AliasState | null>(null);
	const [err, setErr] = useState<string | null>(null);
	return (
		<section className="card">
			<span className="eyebrow">[ Lookup ]</span>
			<h2>Alias state for any address</h2>
			<p className="lede">The AddressAliases object id is derived from (0xa, AliasKey(address)), so no indexer is needed.</p>
			<div className="inline mt">
				<input className="mono" data-testid="lookup" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x..." />
				<button className="ghost" data-testid="lookup-go" disabled={!addr} onClick={async () => {
					setErr(null);
					try { setState(await readAliasState(client, normalizeSuiAddress(addr))); } catch (e) { setErr(String(e)); }
				}}>Look up</button>
			</div>
			{err && <p className="inline-err">{err}</p>}
			{state && (
				<div className="result" data-testid="lookup-result">
					<p>
						{state.enabled
							? <><span className="tag good">Aliases enabled</span> <span className="nowrap">Object <code>{short(state.objectId)}</code></span></>
							: <><span className="tag plain">No aliases</span> {short(state.objectId)} does not exist, so only the address's own key can sign.</>}
					</p>
					<ul className="keys">{state.aliases.map((a) => (
						<li key={a}><span className="kicon">{Icon.key}</span><div className="kbody"><code title={a}>{a}</code></div></li>
					))}</ul>
				</div>
			)}
		</section>
	);
}

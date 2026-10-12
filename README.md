# Face ID Wallet: Seedless Sui Accounts With Passkeys and Address Aliases

Day 1 of Account Layer Week at SuiHub Lagos.

A wallet with no seed phrase. You sign up with a passkey (Face ID, Touch ID, Windows Hello, a phone or a security key), send SUI or USDC with gas paid by a sponsor, add a recovery key with `sui::address_alias`, lose the first passkey on purpose, and rotate to a new one. The address and the balance never change.

Live: https://day1-seedless-wallet.vercel.app (Sui testnet)

## What is in here

| Path | What it does |
| --- | --- |
| `src/lib/passkey.ts` | `PasskeyKeypair` registration, returning sign-in (public key from two signatures), signer construction |
| `src/shared/sui.ts` | gRPC client, alias helpers (`enable`, `add`, `remove`, `replace_all`), derived `AddressAliases` id, `readAliasState` for any address |
| `src/lib/wallet.ts` | Transaction pipeline: build with the sponsor as gas owner, preview, passkey prompt, sponsor |
| `api/sponsor.ts` | Sponsor policy check, co-sign, execute. Holds the sponsor key (`SPONSOR_SECRET_KEY`), never shipped to the browser |
| `api/explain.ts` | "What am I signing?": decodes the commands, simulates, asks DeepSeek for a two-sentence preview |
| `api/fund.ts` | Demo faucet: 0.05 SUI or 0.25 USDC from the sponsor to an empty account |
| `scripts/rehearse.ts` | The whole lifecycle in Node with software passkeys, through the same API handlers |
| `scripts/e2e-browser.ts` | The whole lifecycle in headless Chrome with a CDP virtual authenticator (real WebAuthn) |
| `scripts/soft-passkey.ts` | A software authenticator implementing the SDK's `PasskeyProvider` |
| `scripts/origin-binding.ts` | Shows a localhost passkey is invisible to the Vercel origin |

## Setup from a fresh clone

Node 22+, pnpm.

```bash
git clone https://github.com/Nuel-osas/day1-seedless-wallet
cd day1-seedless-wallet
pnpm install
cp .env.example .env
```

Fill `.env`:

- `SPONSOR_SECRET_KEY`: a `suiprivkey1...` testnet key with SUI in its address balance. It pays gas for every user and funds the demo faucet. Export one with `sui keytool export --key-identity <alias>`.
- `DEEPSEEK_API_KEY`: optional. Without it the review screen shows only the decoded facts.

```bash
pnpm dev            # http://localhost:5291, API functions run inside the Vite dev server
pnpm rehearse       # full lifecycle on testnet with software passkeys
pnpm e2e            # full lifecycle in headless Chrome, needs pnpm dev running and Google Chrome installed
APP_URL=https://day1-seedless-wallet.vercel.app pnpm e2e   # same, against the deployment
pnpm alias 0x...    # print alias state for any address
```

Deploy:

```bash
vercel deploy --prod --yes --cwd /absolute/path/to/day1-seedless-wallet
printf '%s' "$SPONSOR_SECRET_KEY" | vercel env add SPONSOR_SECRET_KEY production --cwd /absolute/path/to/day1-seedless-wallet
printf '%s' "$DEEPSEEK_API_KEY"   | vercel env add DEEPSEEK_API_KEY production --cwd /absolute/path/to/day1-seedless-wallet
```

## Passkeys are bound to the origin

A passkey is created for an RP ID, which is the host name of the page (`localhost`, or `day1-seedless-wallet.vercel.app`). The browser will only offer it to pages on that host. The consequences:

- A passkey created on `localhost` does not exist as far as the Vercel URL is concerned, and the reverse. Your local test account and your deployed account are two different accounts with two different addresses.
- Preview deployments (`day1-seedless-wallet-git-xyz.vercel.app`) are different hosts too. Use the production domain, or set `rp.id` to a parent domain you own and serve every environment under it.
- Passkeys need a secure context: HTTPS, or `localhost`. A LAN IP like `http://192.168.1.10:5291` will not work, so test phones against the deployment.
- The chain never checks the origin. Validators verify the secp256r1 signature over `authenticatorData || sha256(clientDataJSON)` and that the challenge is the transaction digest. Origin binding is the authenticator's protection against phishing, enforced on the device.
- Changing the domain later strands every existing passkey. This is exactly what address aliases fix: add a passkey created on the new domain as an alias, then remove the old one.

## How the pieces work

Sign up. `PasskeyKeypair.getPasskeyInstance(new BrowserPasskeyProvider(...))` calls `navigator.credentials.create` with ES256 (`alg: -7`). The public key is only returned at creation, so the app stores it in `localStorage`. The Sui address is `blake2b(0x06 || compressed_pubkey)`.

Returning sign-in. On a new browser the public key is unknown. `PasskeyKeypair.signAndRecover` gets one signature and recovers up to four candidate public keys; a second signature over a different message leaves exactly one in common (`findCommonPublicKey`). That is two OS prompts.

Sponsored gas. The browser builds the transaction with `setSender(account)`, `setGasOwner(sponsor)` and `setGasPayment([])`, which means gas comes from the sponsor's address balance. The SDK adds a `ValidDuring` expiration for replay protection. Because no gas coins are chosen, the bytes are final before the sponsor sees them, so the user signs first and the sponsor co-signs after checking its policy (gas owner, budget cap, allowlisted calls, no withdrawals from the sponsor, no sponsor-owned objects). Two signatures, one transaction. The passkey account never holds SUI for gas.

Address aliases. `0x2::address_alias` keeps, per address, an `AddressAliases` object holding a set of up to 8 addresses allowed to sign for it. The object is a derived object of the system singleton `0xa`, keyed by `AliasKey(owner)`, so its id is computable for any address (`aliasesObjectId` in `src/shared/sui.ts`). At signing time validators look that object up for every required signer. No object: only the address's own key. Object present: only the listed keys, and the account's own key only while it is in the list.

- `enable(&mut AddressAliasState)` creates the object with the sender as the only member and party-transfers it to the sender. It must be its own transaction before any `add`, because the object is transferred, not returned, so nothing later in the same PTB can reference it.
- `add`, `remove`, `replace_all` take `&mut AddressAliases`. Only the owner address can use it as an input, so only a transaction whose sender is the account (signed by any current alias) can change the list.
- All four are `entry fun`, not `public`. No Move package can wrap them: each must be a top-level MoveCall in a PTB, with arguments that are inputs, not results of other calls.
- `remove` and `replace_all` refuse to leave the set empty.

Recovery. The demo adds a second passkey (another device in real life, or the same device in class) or a guardian Ed25519 key as an alias. To simulate loss it deletes the first passkey. The recovery key signs a transaction whose sender is the original address. Rotation is one PTB with two top-level commands: `add(new passkey)` and `remove(original address)`. The original passkey is then refused at signature verification.

## Demo script for class

1. Open the live URL. Create wallet with passkey. Show the address and the zero balances.
2. Get 0.05 test SUI (or use the Circle faucet for USDC, network Sui Testnet).
3. Send 0.001 SUI. Read the "What am I signing?" preview, approve, open the digest on Suiscan: sender is the passkey address, gas sponsor is the sponsor, two signatures.
4. Turn on recovery. Show the alias list: one entry, the account itself.
5. Add recovery passkey (or on a phone: open the site, Create recovery passkey, paste its address into Add address).
6. Simulate losing this device. Recover an account: same address, Recover with a recovery passkey.
7. Send 0.001 SUI. The signer is the recovery key, the sender is the original address.
8. Rotate to a new passkey. The alias list loses the original key and gains the new one.
9. Send again. Look up the account in "Alias state for any address". Address and balance unchanged.

## Verified on testnet

Run with `APP_URL=https://day1-seedless-wallet.vercel.app pnpm e2e`: headless Chrome, CDP virtual authenticator, real WebAuthn against the deployed origin. Account `0x1a7442001295c23fbc8820ae4c74d7154fb8bcc5c3f945f167a803253f4b8433`.

| Step | Digest |
| --- | --- |
| First send, sponsored, signed by passkey (signature flags 6 and 0) | `CXGTFEEqPvm8BmfpzsZN6MgTSXMT1bt5qbLcEfhDx8pB` |
| `address_alias::enable` | `96NmPZhFZgkgBNGESzLJtoQ7sMic4Jep4vpH6H7N46mX` |
| `address_alias::add` recovery passkey | `F8oFA2ExzLnf1zPX6PFN8rw9xo9QNTGEqRbRSkFkJ7gr` |
| Send as the original address, signed by the recovery passkey | `8RUKx9Q59UdJ8dRLhAcPiB2Rum5ngSzh1SKpASJdajXh` |
| Rotate: `add` new passkey + `remove` original in one PTB | `FytKnGWkd6YaaPh3zQfhwtfLGeCFHHuNtzr3ENS2e9dT` |
| Send signed by the new passkey, same address | `A2EHnzszLZdxUjP6Noo8M6vXGnAfiERoaCtjYoFMUP92` |

`scripts/origin-binding.ts` creates a passkey on localhost and then asks for one on the Vercel URL with the same authenticator: `NotAllowedError`.

Mainnet protocol config (version 138) has `passkey_auth: true`, `address_aliases: true` and `accept_passkey_in_multisig: true`, and the `AddressAliasState` object `0xa` exists on mainnet.

// Drives the real app in headless Chrome with a CDP virtual authenticator, so every passkey
// prompt is real WebAuthn (navigator.credentials) against the page's origin.
//   APP_URL=http://localhost:5291 pnpm e2e        (or the Vercel URL)
import puppeteer, { type Page } from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const APP = process.env.APP_URL ?? 'http://localhost:5291';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS ?? new URL('./.shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1300 });
page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text().slice(0, 200)));
const cdp = await page.createCDPSession();
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
	options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const creds = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;

const digests: Record<string, string> = {};
const text = (sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText.trim());
const shot = (n: string) => page.screenshot({ path: `${SHOTS}${n}.png`, fullPage: true });

async function waitIdle() {
	await page.waitForFunction(() => !document.querySelector('[data-testid=busy]'), { timeout: 90_000 });
	const err = await page.$('[data-testid=error]');
	if (err) throw new Error('app error: ' + (await text('[data-testid=error]')));
}
async function clickAndApprove(sel: string, label: string) {
	const before = (await page.$$('[data-testid=digest]')).length;
	await page.click(sel);
	await page.waitForSelector('[data-testid=review]', { timeout: 90_000 });
	const preview = await text('[data-testid=preview]');
	console.log(`  preview: ${preview}`);
	await shot(`review-${label}`);
	await page.click('[data-testid=approve]');
	await page.waitForFunction((n) => document.querySelectorAll('[data-testid=digest]').length > n || !!document.querySelector('[data-testid=error]'), { timeout: 120_000 }, before);
	await waitIdle();
	const d = await text('[data-testid=digest]');
	digests[label] = d;
	console.log(`  ${label}: ${d}`);
	await new Promise((r) => setTimeout(r, 2500));
}
async function typeInto(sel: string, value: string) {
	await page.click(sel, { count: 3 });
	await page.keyboard.press('Backspace');
	await page.type(sel, value);
}
const aliasList = () => page.$$eval('[data-testid=aliases] code', (els) => els.map((e) => e.textContent));
async function clickText(t: string) {
	await page.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)!.click(), t);
}

await page.goto(APP, { waitUntil: 'networkidle0' });

console.log('1. create passkey account');
await page.click('[data-testid=create]');
await page.waitForSelector('[data-testid=account]');
const X = await text('[data-testid=account]');
const credA = (await creds())[0].credentialId;
console.log('  account X =', X);

console.log('2. sign out, sign back in by recovering the public key from two signatures');
await clickText('Sign out');
await page.click('[data-testid=signin]');
await page.waitForSelector('[data-testid=account]', { timeout: 60_000 });
const again = await text('[data-testid=account]');
if (again !== X) throw new Error(`sign-in recovered ${again}, expected ${X}`);
console.log('  recovered same address');

console.log('3. fund and first sponsored send');
await page.click('[data-testid=fund-sui]');
await waitIdle();
await page.waitForFunction(() => document.querySelector('[data-testid=bal-SUI]')?.textContent !== '0', { timeout: 30_000 });
const sponsor = await page.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.sponsor));
await typeInto('[data-testid=to]', sponsor);
await clickAndApprove('[data-testid=send]', 'first-send-sponsored');
await shot('after-first-send');

console.log('4. turn on recovery, add a recovery passkey');
await clickAndApprove('[data-testid=enable]', 'alias-enable');
await page.waitForSelector('[data-testid=add-recovery-passkey]', { timeout: 30_000 });
await clickAndApprove('[data-testid=add-recovery-passkey]', 'alias-add-recovery-passkey');
await page.waitForFunction(() => document.querySelectorAll('[data-testid=aliases] code').length === 2, { timeout: 30_000 });
const B = (await aliasList()).find((a) => a !== X)!;
console.log('  aliases:', await aliasList());
const balBefore = await text('[data-testid=bal-SUI]');

console.log('5. lose the first passkey: wipe app state AND delete credential A from the authenticator');
await page.click('[data-testid=lose]');
await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: credA });
console.log('  credentials left on authenticator:', (await creds()).length);

console.log('6. recover: recovery passkey B signs as X');
await page.waitForSelector('[data-testid=recover-account]');
await typeInto('[data-testid=recover-account]', X);
await page.click('[data-testid=recover-passkey]');
await page.waitForSelector('[data-testid=account]', { timeout: 60_000 });
console.log('  ', await text('[data-testid=signer]'));
if ((await text('[data-testid=account]')) !== X) throw new Error('account changed');
await typeInto('[data-testid=to]', sponsor);
await clickAndApprove('[data-testid=send]', 'send-as-X-signed-by-recovery');

console.log('7. rotate to a new passkey C, removing the lost key in the same PTB');
await clickAndApprove('[data-testid=rotate]', 'rotate-add-new-remove-old');
await page.waitForFunction((x) => ![...document.querySelectorAll('[data-testid=aliases] code')].some((e) => e.textContent === x), { timeout: 30_000 }, X);
const after = await aliasList();
console.log('  aliases after rotation:', after);
console.log('  ', await text('[data-testid=signer]'));

console.log('8. send with the new passkey, still as X');
await typeInto('[data-testid=to]', sponsor);
await clickAndApprove('[data-testid=send]', 'send-as-X-signed-by-new-passkey');
await page.click('[data-testid=lookup]');
await page.keyboard.type(X);
await page.click('[data-testid=lookup-go]');
await page.waitForSelector('[data-testid=lookup-result]');
await new Promise((r) => setTimeout(r, 2000));
await shot('final');
const balAfter = await text('[data-testid=bal-SUI]');
const finalAccount = await text('[data-testid=account]');
console.log(`\naccount before ${X}\naccount after  ${finalAccount}\nSUI before recovery ${balBefore}, after ${balAfter} (two 0.001 sends, no gas)`);

const out = { app: APP, X, recoveryKey: B, aliasesAfter: after, digests };
writeFileSync(new URL('./.e2e-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();

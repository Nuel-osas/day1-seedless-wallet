// Shows origin binding: a passkey created on localhost is invisible to the Vercel origin.
//   pnpm tsx scripts/origin-binding.ts   (needs pnpm dev running)
import puppeteer from 'puppeteer-core';

const LOCAL = process.env.LOCAL_URL ?? 'http://localhost:5291';
const LIVE = process.env.APP_URL ?? 'https://day1-seedless-wallet.vercel.app';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
	options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

await page.goto(LOCAL, { waitUntil: 'networkidle0' });
await page.click('[data-testid=create]');
await page.waitForSelector('[data-testid=account]');
const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
console.log(`created on ${LOCAL}: rpId=${creds[0].rpId}, credentials on authenticator: ${creds.length}`);

await page.goto(LIVE, { waitUntil: 'networkidle0' });
const result = await page.evaluate(async () => {
	try {
		await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: 'required', timeout: 5000 } });
		return 'got a credential (unexpected)';
	} catch (e) {
		return `${(e as Error).name}: ${(e as Error).message}`;
	}
});
console.log(`sign-in attempt on ${LIVE} with the same authenticator: ${result}`);
await browser.close();

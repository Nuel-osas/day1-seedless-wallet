import { getSponsor, json } from './_lib/server.js';
import { NETWORK } from '../src/shared/sui.js';

export function GET() {
	return json({ network: NETWORK, sponsor: getSponsor().toSuiAddress(), deepseek: !!process.env.DEEPSEEK_API_KEY });
}

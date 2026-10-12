// pnpm tsx scripts/balances.ts <address>
import { makeClient } from '../src/shared/sui.js';
const r = await makeClient().core.listBalances({ owner: process.argv[2] });
console.log(JSON.stringify(r.balances, null, 1));

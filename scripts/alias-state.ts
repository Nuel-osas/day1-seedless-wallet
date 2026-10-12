// pnpm alias <address>: alias state for any address, the same lookup validators do.
import { makeClient, readAliasState } from '../src/shared/sui.js';
console.log(await readAliasState(makeClient(), process.argv[2]));

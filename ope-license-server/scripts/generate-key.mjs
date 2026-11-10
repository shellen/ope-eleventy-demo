// ABOUTME: Prints a new private signing key for the License Server, as one line of JSON.
// ABOUTME: Paste the output into the OPE_LS_KEY environment variable. Never commit it or share it.

import { generateKeyPair, exportJWK } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
console.log(JSON.stringify(await exportJWK(privateKey)));

/**
 * Currency ContextVM server readiness probe.
 *
 * Connects to the currency CVM server over Nostr and issues a single
 * `get_btc_price` request. Exits 0 when the server answers with rates,
 * non-zero otherwise. Used by CI to gate the integration test suite on
 * the currency server being live (replaces the deleted fetch-btc-price.ts).
 *
 * Usage: bun run scripts/probe-currency.ts [relayUrl]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool } from '@contextvm/sdk'
import { resolveCvmServerPubkey } from '../src/lib/cvm-identity'

const RELAY_URL = process.argv[2] || process.env.APP_RELAY_URL || 'ws://localhost:10547'

const CVM_SERVER_PUBKEY = (() => {
	try {
		return resolveCvmServerPubkey()
	} catch {
		console.error('CVM_SERVER_KEY or CVM_SERVER_PUBKEY is required. Set one in your environment.')
		process.exit(1)
	}
})()

const ephemeralKey = crypto.getRandomValues(new Uint8Array(32))
const hexKey = Array.from(ephemeralKey)
	.map((b) => b.toString(16).padStart(2, '0'))
	.join('')

console.log(`Probing currency server on relay: ${RELAY_URL}`)
console.log(`Server pubkey: ${CVM_SERVER_PUBKEY}`)

const signer = new PrivateKeySigner(hexKey)
const relayPool = new ApplesauceRelayPool([RELAY_URL])

const transport = new NostrClientTransport({
	signer,
	relayHandler: relayPool,
	serverPubkey: CVM_SERVER_PUBKEY,
	isStateless: true,
})

const client = new Client({ name: 'currency-probe', version: '1.0.0' })

try {
	await client.connect(transport)
	const result = await client.callTool({ name: 'get_btc_price', arguments: {} })
	const structured = (result as any)?.structuredContent

	if (structured?.rates) {
		console.log('Currency server responded with rates. Ready.')
		await client.close()
		process.exit(0)
	}

	console.error('Currency server responded without rates:', JSON.stringify(result))
	await client.close()
	process.exit(1)
} catch (error) {
	console.error('Currency server probe failed:', error instanceof Error ? error.message : error)
	process.exit(1)
}

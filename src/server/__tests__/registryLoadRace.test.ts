import { describe, expect, test } from 'bun:test'
import { EventHandler } from '../EventHandler'
import { EventSigner } from '../EventSigner'
import { Nip05ManagerImpl } from '../Nip05Manager'
import { VanityManagerImpl } from '../VanityManager'
import { BlacklistManagerImpl } from '../BlacklistManager'

// Deterministic regression test for the READ-path connect race:
// on restart the NIP-05 / vanity registries were silently dropped because the
// LOAD was gated behind NDK 3.0.3's connect() promise, which can stay
// unresolved (or lose its timeout race) while the relay is actually connected
// and fetchEvents returns the persisted kind-30000 registry event fine.
//
// Before the fix, connectAndLoadRegistries early-returned when connect() did
// not resolve, so loadExisting*Registry was never called and the served
// /.well-known/nostr.json stayed empty. This test reproduces exactly that:
// a fake NDK whose connect() never resolves, whose pool reports a live socket,
// and whose fetchEvents returns the persisted registry. The load must still run
// and the name must be served.

// Deterministic throwaway app key (test-only, not a real credential).
const APP_PRIV = '0'.repeat(63) + '1'
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
const ALICE_PUBKEY = 'a'.repeat(64)
const COOLURL_PUBKEY = 'b'.repeat(64)

function fakeEvent(tags: string[][]): any {
	const raw = { id: 'fake', kind: 30000, tags, content: '', created_at: FAR_FUTURE, pubkey: 'app', sig: '' }
	return { rawEvent: () => raw, tags }
}

// A fake NDK that mimics the race: connect() does not resolve successfully, but
// the socket is up (connectedRelays reports one) and fetchEvents returns the
// persisted event. We reject immediately rather than hang for the full 10s
// connect timeout — the code takes the identical `connectSucceeded = false`
// branch either way, and rejecting keeps the test fast/deterministic.
function makeRacingNdk(): any {
	return {
		connect: () => Promise.reject(new Error('connect raced/never resolved')), // the race: connect never succeeds
		pool: { connectedRelays: () => [{ url: 'ws://local' }] },
		fetchEvents: async (filter: any) => {
			const dTag = filter['#d']?.[0]
			if (dTag === 'nip05-names') {
				return new Set([
					fakeEvent([
						['d', 'nip05-names'],
						['nip05', 'alice', ALICE_PUBKEY, String(FAR_FUTURE)],
					]),
				])
			}
			if (dTag === 'vanity-urls') {
				return new Set([
					fakeEvent([
						['d', 'vanity-urls'],
						['vanity', 'coolurl', COOLURL_PUBKEY, String(FAR_FUTURE)],
					]),
				])
			}
			return new Set() // blacklist (kind 10000) etc.
		},
	}
}

function buildHandlerWithRacingNdk() {
	// Fresh, uninitialized singleton; we wire real managers by hand so we can
	// call the private connectAndLoadRegistries against the fake NDK.
	;(EventHandler as any).instance = undefined
	const handler = EventHandler.getInstance() as any
	const signer = new EventSigner(APP_PRIV)
	const ndk = makeRacingNdk()

	const nip05 = new Nip05ManagerImpl(signer)
	const vanity = new VanityManagerImpl(signer)
	const blacklist = new BlacklistManagerImpl(signer, {} as any)
	nip05.setNDK(ndk)
	vanity.setNDK(ndk)
	blacklist.setNDK(ndk)

	handler.eventSigner = signer
	handler.nip05Manager = nip05
	handler.vanityManager = vanity
	handler.blacklistManager = blacklist

	return { handler, nip05, vanity, ndk, appPubkey: signer.getAppPubkey() }
}

describe('registry load survives the connect-promise race (names persist on restart)', () => {
	test('loads and serves the NIP-05 name even though connect() never resolves', async () => {
		const { handler, nip05, ndk, appPubkey } = buildHandlerWithRacingNdk()

		const outcome = await handler.connectAndLoadRegistries(ndk, appPubkey)

		// The load ran despite connect() never resolving, and the served
		// nostr.json now contains the persisted name (was {} before the fix).
		expect(outcome.loadSucceeded).toBe(true)
		expect(nip05.buildNostrJson('alice')).toEqual({ names: { alice: ALICE_PUBKEY } })
		expect(nip05.buildNostrJson().names.alice).toBe(ALICE_PUBKEY)
	})

	test('loads the vanity registry under the same race', async () => {
		const { handler, vanity, ndk, appPubkey } = buildHandlerWithRacingNdk()

		await handler.connectAndLoadRegistries(ndk, appPubkey)

		expect(vanity.getEntry('coolurl')?.pubkey).toBe(COOLURL_PUBKEY)
	})

	test('reports connected (via the live socket) so the retry loop stops', async () => {
		const { handler, ndk, appPubkey } = buildHandlerWithRacingNdk()

		const outcome = await handler.connectAndLoadRegistries(ndk, appPubkey)

		// connect() never resolved, but a successful fetch + live socket mean the
		// relay is reachable, so planNdkBootstrap will not schedule a needless retry.
		expect(outcome.connectSucceeded).toBe(true)
	})
})

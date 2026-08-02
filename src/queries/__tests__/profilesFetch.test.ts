import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { NDKUser, NDKUserProfile } from '@nostr-dev-kit/ndk'

import { ndkActions } from '@/lib/stores/ndk'
import { fetchProfileByIdentifier } from '../profiles'

// `fetchProfileByIdentifier` reads NDK from the `ndkActions` store, so we stub
// `getNDK` (the orders-seam.test.ts pattern) to drive each behavioral case.
const realGetNDK = ndkActions.getNDK
const realSetTimeout = globalThis.setTimeout

afterEach(() => {
	;(ndkActions as { getNDK: () => unknown }).getNDK = realGetNDK as () => unknown
	globalThis.setTimeout = realSetTimeout as typeof globalThis.setTimeout
})

const VALID_HEX = 'a'.repeat(64)

/** A minimal NDKUser stub: just enough (pubkey + fetchProfile) for the fetcher. */
function stubUser(profile: NDKUserProfile | null): NDKUser {
	return { pubkey: VALID_HEX, fetchProfile: async () => profile } as unknown as NDKUser
}

/** Minimal NDK stub: a relay pool that reports `connected` live relays + a fetchUser. */
function stubNdk(opts: { connectedRelays: number; fetchUser: (identifier: string) => Promise<NDKUser | null> }) {
	return {
		pool: { connectedRelays: () => Array.from({ length: opts.connectedRelays }, () => ({})) },
		fetchUser: opts.fetchUser,
	}
}

describe('fetchProfileByIdentifier distinguishes genuine absence from transient failures', () => {
	test('returns the profile when relays are connected and fetchProfile resolves data', async () => {
		const profile = { name: 'alice', about: 'hi' } as NDKUserProfile
		const user = stubUser(profile)
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 1, fetchUser: async () => user })

		const result = await fetchProfileByIdentifier(VALID_HEX)

		expect(result.profile).toBe(profile)
		expect(result.user).toBe(user)
	})

	test('returns { profile: null, user } for genuine absence (connected, fetchProfile resolved null)', async () => {
		const user = stubUser(null)
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 1, fetchUser: async () => user })

		const result = await fetchProfileByIdentifier(VALID_HEX)

		// A successful null — NOT a transient failure. React Query commits this as
		// a successful result, which is what lets ProfilePage show "not found".
		expect(result.profile).toBeNull()
		expect(result.user).toBe(user)
	})

	test('throws on timeout instead of returning a null-shaped success', async () => {
		// fetchProfile never settles; the timeout must win the race and throw.
		const hangingUser = { pubkey: VALID_HEX, fetchProfile: () => new Promise<NDKUserProfile | null>(() => {}) } as unknown as NDKUser
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 1, fetchUser: async () => hangingUser })
		// Fire the timeout reject immediately so the test doesn't wait 8s.
		globalThis.setTimeout = ((cb: () => void) => {
			cb()
			return 0 as unknown as ReturnType<typeof globalThis.setTimeout>
		}) as typeof globalThis.setTimeout

		await expect(fetchProfileByIdentifier(VALID_HEX)).rejects.toThrow('Profile fetch timed out')
	})

	test('throws when fetchProfile rejects (relay error) instead of returning null', async () => {
		const user = { pubkey: VALID_HEX, fetchProfile: async () => Promise.reject(new Error('relay boom')) } as unknown as NDKUser
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 1, fetchUser: async () => user })

		await expect(fetchProfileByIdentifier(VALID_HEX)).rejects.toThrow('relay boom')
	})

	test('throws when ndk.fetchUser rejects instead of returning null', async () => {
		;(ndkActions as { getNDK: () => unknown }).getNDK = () =>
			stubNdk({ connectedRelays: 1, fetchUser: async () => Promise.reject(new Error('fetchUser boom')) })

		await expect(fetchProfileByIdentifier(VALID_HEX)).rejects.toThrow('fetchUser boom')
	})

	test('throws on no relay connection instead of returning null', async () => {
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 0, fetchUser: async () => stubUser(null) })

		await expect(fetchProfileByIdentifier(VALID_HEX)).rejects.toThrow('No relay connection')
	})

	test('throws when NDK is not initialized', async () => {
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => null

		await expect(fetchProfileByIdentifier(VALID_HEX)).rejects.toThrow('NDK not initialized')
	})
})

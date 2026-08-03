import { afterEach, describe, expect, mock, test } from 'bun:test'

import { ndkActions } from '@/lib/stores/ndk'
import { fetchProfileByIdentifier } from '../profiles'

// Infer NDK return types from the function under test instead of importing
// the NDK package directly — the NDK-footprint CI guard counts any src/ file
// containing the NDK package import path, and this test file must not
// increase the 127-file baseline.
type FetchResult = Awaited<ReturnType<typeof fetchProfileByIdentifier>>
type NDKUserLike = NonNullable<FetchResult['user']>
type NDKUserProfileLike = NonNullable<FetchResult['profile']>

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
function stubUser(profile: NDKUserProfileLike | null): NDKUserLike {
	return { pubkey: VALID_HEX, fetchProfile: async () => profile } as unknown as NDKUserLike
}

/** Minimal NDK stub: a relay pool that reports `connected` live relays + a fetchUser. */
function stubNdk(opts: { connectedRelays: number; fetchUser: (identifier: string) => Promise<NDKUserLike | null> }) {
	return {
		pool: { connectedRelays: () => Array.from({ length: opts.connectedRelays }, () => ({})) },
		fetchUser: opts.fetchUser,
	}
}

describe('fetchProfileByIdentifier distinguishes genuine absence from transient failures', () => {
	test('returns the profile when relays are connected and fetchProfile resolves data', async () => {
		const profile = { name: 'alice', about: 'hi' } as NDKUserProfileLike
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
		const hangingUser = {
			pubkey: VALID_HEX,
			fetchProfile: () => new Promise<NDKUserProfileLike | null>(() => {}),
		} as unknown as NDKUserLike
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 1, fetchUser: async () => hangingUser })
		// Fire the timeout reject immediately so the test doesn't wait 8s.
		globalThis.setTimeout = ((cb: () => void) => {
			cb()
			return 0 as unknown as ReturnType<typeof globalThis.setTimeout>
		}) as typeof globalThis.setTimeout

		await expect(fetchProfileByIdentifier(VALID_HEX)).rejects.toThrow('Profile fetch timed out')
	})

	test('throws when fetchProfile rejects (relay error) instead of returning null', async () => {
		const user = { pubkey: VALID_HEX, fetchProfile: async () => Promise.reject(new Error('relay boom')) } as unknown as NDKUserLike
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

	test('returns { profile: null, user: null } for a malformed identifier without a relay request', async () => {
		const fetchUser = mock(async () => stubUser(null))
		;(ndkActions as { getNDK: () => unknown }).getNDK = () => stubNdk({ connectedRelays: 1, fetchUser })

		const result = await fetchProfileByIdentifier('not-a-valid-identifier')

		expect(result).toEqual({ profile: null, user: null })
		expect(fetchUser).toHaveBeenCalledTimes(0)
	})
})

import { describe, test, expect } from 'bun:test'
import { serializeProfile, type NDKUserProfile } from '@nostr-dev-kit/ndk'
import { getProfileName } from '@/queries/profiles'

// NIP-24 interop: magick.market must publish kind-0 metadata using the standard
// field names (display_name, picture, about) so spec-compliant clients render a
// user's name and avatar. The write path (src/publish/profiles.tsx) serializes
// with NDK's serializeProfile; these tests pin that the exact profile-form shape
// produces standard keys, and that the name reader accepts both the standard and
// the legacy camelCase keys so already-published profiles keep rendering.

describe('profile kind-0 write serialization (NIP-24)', () => {
	test('serializes the profile-form shape to standard NIP-24 keys', () => {
		// This is exactly the object src/routes/.../account/profile.tsx builds and
		// hands to updateProfile (formData + banner + image).
		const profileData: NDKUserProfile = {
			name: 'grinmerchant',
			displayName: 'Grin Merchant',
			about: 'Selling widgets for Grin',
			nip05: 'merchant@example.com',
			website: 'https://example.com',
			banner: 'https://example.com/banner.png',
			image: 'https://example.com/avatar.png',
		}

		const content = JSON.parse(serializeProfile(profileData)) as Record<string, unknown>

		// Standard NIP-24 names are emitted...
		expect(content.display_name).toBe('Grin Merchant')
		expect(content.picture).toBe('https://example.com/avatar.png')
		expect(content.about).toBe('Selling widgets for Grin')
		expect(content.name).toBe('grinmerchant')

		// ...and the non-standard camelCase names are NOT written.
		expect(content.displayName).toBeUndefined()
		expect(content.image).toBeUndefined()

		// Other standard fields pass through unchanged.
		expect(content.nip05).toBe('merchant@example.com')
		expect(content.website).toBe('https://example.com')
		expect(content.banner).toBe('https://example.com/banner.png')
	})
})

describe('getProfileName read-both shim', () => {
	test('reads the NIP-01 name first', () => {
		expect(getProfileName({ profile: { name: 'satoshi', displayName: 'Satoshi N' } })).toBe('satoshi')
	})

	test('falls back to NDK camelCase displayName', () => {
		expect(getProfileName({ profile: { displayName: 'Satoshi N' } })).toBe('Satoshi N')
	})

	test('falls back to legacy standard display_name key', () => {
		expect(getProfileName({ profile: { display_name: 'Satoshi N' } as NDKUserProfile })).toBe('Satoshi N')
	})

	test('returns empty string for a null or nameless profile', () => {
		expect(getProfileName({ profile: null })).toBe('')
		expect(getProfileName({ profile: {} })).toBe('')
	})
})

import { ndkActions } from '@/lib/stores/ndk'
import { profileKeys } from '@/queries/queryKeyFactory'
import { NDKEvent, serializeProfile, type NDKUserProfile } from '@nostr-dev-kit/ndk'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ensureCanSign, isSigningCancelled } from '@/lib/goblin/signGate'

/**
 * Updates the user's profile on the Nostr network.
 *
 * @param profile The profile data to publish
 * @returns Promise that resolves when the profile is published
 */
export const updateProfile = async (profile: NDKUserProfile): Promise<void> => {
	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')

	if (!profile) throw new Error('Profile data is required')

	// Owner expectation: if this session can't sign (a wallet-verified view-only
	// Goblin login, an expired session window, or a session the wallet ended), take
	// the user back to their wallet to authorize instead of throwing. Resolves once a
	// signer exists, so we continue below with the form data intact; a cancel throws
	// SigningCancelledError, which the mutation's onError treats as a benign no-op.
	await ensureCanSign()

	if (!ndk.signer) throw new Error('No signer available')

	const user = await ndk.signer.user()
	if (!user) throw new Error('No active user')

	const connectedRelays = ndk.pool?.connectedRelays() || []
	if (connectedRelays.length === 0) {
		throw new Error('No connected relays. Please check your relay connections and try again.')
	}

	// Create a kind 0 (metadata) event manually.
	// Serialize with NDK's serializeProfile so the content uses the standard
	// NIP-24 field names (display_name, picture, about) instead of NDK's
	// in-memory camelCase (displayName, image). This keeps a magick.market
	// user's name and avatar rendering correctly in spec-compliant clients.
	const profileEvent = new NDKEvent(ndk)
	profileEvent.kind = 0
	profileEvent.content = serializeProfile(profile)
	profileEvent.created_at = Math.floor(Date.now() / 1000)
	profileEvent.pubkey = user.pubkey

	try {
		// Sign the event
		await profileEvent.sign(ndk.signer)
		const publishedRelays = await ndkActions.publishEvent(profileEvent)

		if (publishedRelays.size === 0) {
			throw new Error('Profile was not published to any relays. Check your relay connections.')
		}
	} catch (error) {
		console.error('❌ Error during profile publish:', error)
		console.error('Connected relays at time of error:', ndk.pool?.connectedRelays()?.map((r) => r.url) || [])
		throw error
	}
}

/**
 * Mutation hook for updating a user profile.
 * Handles invalidating the related queries for proper cache updates.
 */
export const useUpdateProfileMutation = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: updateProfile,
		onSuccess: async (_, profile) => {
			// Get the pubkey of the active user
			const ndk = ndkActions.getNDK()
			const pubkey = ndk?.activeUser?.pubkey

			if (pubkey) {
				// Invalidate relevant queries to trigger refetching
				await queryClient.invalidateQueries({ queryKey: profileKeys.details(pubkey) })

				toast.success('Profile updated successfully')
			}
		},
		onError: (error) => {
			// User dismissed the wallet re-authorization prompt: not a failure.
			if (isSigningCancelled(error)) return
			console.error('Failed to update profile:', error)
			toast.error('Failed to update profile')
		},
	})
}

/**
 * Updates a specific field of the user's profile.
 * Useful for single field updates without affecting other fields.
 *
 * @param field The profile field to update
 * @param value The new value for the field
 */
export const useUpdateProfileFieldMutation = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: async ({ field, value }: { field: string; value: string | undefined }) => {
			const ndk = ndkActions.getNDK()
			if (!ndk) throw new Error('NDK not initialized')

			const user = ndk.activeUser
			if (!user) throw new Error('No active user')

			// Fetch current profile
			const currentProfile = user.profile || {}

			// Update the specific field
			const updatedProfile = {
				...currentProfile,
				[field]: value,
			}

			// Update the user's profile and publish
			user.profile = updatedProfile
			await user.publish()

			return updatedProfile
		},
		onSuccess: async (updatedProfile, { field }) => {
			// Get the pubkey of the active user
			const ndk = ndkActions.getNDK()
			const pubkey = ndk?.activeUser?.pubkey

			if (pubkey) {
				// Invalidate relevant queries
				await queryClient.invalidateQueries({ queryKey: profileKeys.details(pubkey) })

				// If the updated field was nip05, invalidate that query too
				if (field === 'nip05') {
					await queryClient.invalidateQueries({ queryKey: profileKeys.nip05(pubkey) })
				}

				toast.success(`Profile ${field} updated successfully`)
			}
		},
		onError: (error) => {
			console.error('Failed to update profile field:', error)
			toast.error('Failed to update profile')
		},
	})
}

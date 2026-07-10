import { ndkActions } from '@/lib/stores/ndk'
import { type NDKUserProfile, NDKUser } from '@nostr-dev-kit/ndk'
import { NDKWoT } from '@nostr-dev-kit/wot'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { profileKeys } from './queryKeyFactory'

export const fetchProfileByNpub = async (npub: string): Promise<NDKUserProfile | null> => {
	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')

	try {
		const user = await ndk.fetchUser(npub)
		if (!user) throw new Error('User not found')
		return await user.fetchProfile()
	} catch (e) {
		console.error('Failed to fetch profile with NDK user method', e)
		return null
	}
}

export const fetchProfileByNip05 = async (nip05: string): Promise<NDKUserProfile | null> => {
	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')

	try {
		const user = await ndk.fetchUser(nip05)
		if (!user) throw new Error('User not found')
		return await user.fetchProfile()
	} catch (e) {
		console.error('Failed to fetch profile with NDK user method', e)
		return null
	}
}

export const fetchProfileByIdentifier = async (identifier: string): Promise<{ profile: NDKUserProfile | null; user: NDKUser | null }> => {
	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')

	const timeoutMs = 8000
	try {
		const result = await Promise.race([
			(async () => {
				const user = await ndk.fetchUser(identifier)
				if (!user) return { profile: null, user: null }
				const profile = await user.fetchProfile()
				return { profile, user }
			})(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Profile fetch timed out')), timeoutMs)),
		])
		return result
	} catch (e) {
		console.error('Failed to fetch profile with identifier:', e)
		return { profile: null, user: null }
	}
}

export const profileQueryOptions = (npub: string) =>
	queryOptions({
		queryKey: profileKeys.details(npub),
		queryFn: () => fetchProfileByNpub(npub),
	})

export const profileByNip05QueryOptions = (nip05: string) =>
	queryOptions({
		queryKey: profileKeys.detailsByNip05(nip05),
		queryFn: () => fetchProfileByNip05(nip05),
	})

export const profileByIdentifierQueryOptions = (identifier: string) =>
	queryOptions({
		queryKey: profileKeys.details(identifier),
		queryFn: () => fetchProfileByIdentifier(identifier),
	})

export const validateNip05 = async (pubkey: string): Promise<boolean | null> => {
	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')

	try {
		const user = await ndk.fetchUser(pubkey)
		if (!user) return null

		const profile = await user.fetchProfile()
		if (!profile?.nip05) return null

		return await user.validateNip05(profile.nip05)
	} catch (e) {
		console.error('Error validating NIP-05:', e)
		return false
	}
}

export const nip05ValidationQueryOptions = (pubkey: string) =>
	queryOptions({
		queryKey: profileKeys.nip05(pubkey),
		queryFn: () => validateNip05(pubkey),
	})

// --- DATA EXTRACTION FUNCTIONS ---

export const getProfileName = ({ profile }: { profile: NDKUserProfile | null }): string => {
	if (!profile) return ''
	// Read both the standard NIP-24 key (display_name) and NDK's camelCase
	// (displayName). NDK's profileFromEvent normalizes standard events onto
	// displayName, but reading both keeps legacy magick.market profiles (written
	// with camelCase before the write-path fix) rendering until they republish.
	return profile.name || profile.displayName || (profile as { display_name?: string }).display_name || ''
}

export const getProfileNip05 = ({ profile }: { profile: NDKUserProfile | null }): string | undefined => {
	if (!profile) return undefined
	return profile.nip05
}

// --- REACT QUERY HOOKS ---

export const useProfileName = (pubkey: string) => {
	return useQuery({
		...profileByIdentifierQueryOptions(pubkey),
		select: getProfileName,
	})
}

export const useProfileNip05 = (pubkey: string) => {
	return useQuery({
		...profileByIdentifierQueryOptions(pubkey),
		select: getProfileNip05,
	})
}

export const useProfile = (pubkey: string | undefined) => {
	return useQuery({
		queryKey: profileKeys.details(pubkey ?? ''),
		queryFn: () => fetchProfileByIdentifier(pubkey!),
		enabled: !!pubkey,
		staleTime: 5 * 60 * 1000,
		retry: 2,
	})
}

export const getWotScore = async (pubkey: string): Promise<number | null> => {
	const ndk = ndkActions.getNDK()
	if (!ndk) throw new Error('NDK not initialized')
	if (!ndk.activeUser) return null

	try {
		const wot = new NDKWoT(ndk, pubkey)
		await wot.load({
			depth: 2,
			maxFollows: 1000,
			timeout: 1000,
		})

		const score = wot.getScores([pubkey]).get(pubkey) || 0
		return score
	} catch (e) {
		console.error('Error calculating WoT score:', e)
		return null
	}
}

export const wotScoreQueryOptions = (pubkey: string) =>
	queryOptions({
		queryKey: profileKeys.wot(pubkey),
		queryFn: () => getWotScore(pubkey),
		enabled: !!pubkey,
		retry: 2,
		retryDelay: 1000,
	})

export const useWotScore = (pubkey: string) => {
	return useQuery({
		...wotScoreQueryOptions(pubkey),
		enabled: !!pubkey,
	})
}

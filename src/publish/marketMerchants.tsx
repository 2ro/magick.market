/**
 * Publish helpers for the admin merchant allowlist — the NIP-51 people list
 * (kind 30000, d-tag `market_merchants`) the market operator signs to name the
 * merchants whose stalls make up the shared market. See `lib/market-scope.ts`.
 */
import { submitAppSettings } from '@/lib/appSettings'
import { fetchLatestAppEvent } from '@/lib/stores/ndk'
import { validatePubkey } from '@/lib/schemas/featured'
import { MERCHANT_ALLOWLIST_DTAG, MERCHANT_ALLOWLIST_KIND, clearMerchantAllowlistCache } from '@/lib/market-scope'
import NDK, { NDKEvent, type NDKSigner, type NDKTag } from '@nostr-dev-kit/ndk'

export interface MarketMerchantsData {
	merchants: string[] // Array of merchant pubkeys (hex)
}

/** Build the kind 30000 `market_merchants` list event. */
export const createMarketMerchantsEvent = (data: MarketMerchantsData, _signer: NDKSigner, ndk: NDK): NDKEvent => {
	const event = new NDKEvent(ndk)
	event.kind = MERCHANT_ALLOWLIST_KIND
	event.content = ''
	const tags: NDKTag[] = [
		['d', MERCHANT_ALLOWLIST_DTAG],
		['title', 'Market Merchants'],
	]
	for (const pubkey of data.merchants) tags.push(['p', pubkey])
	event.tags = tags
	return event
}

/** Sign and publish the merchant allowlist through the app-settings channel. */
export const publishMarketMerchants = async (data: MarketMerchantsData, signer: NDKSigner, ndk: NDK): Promise<string> => {
	for (const pubkey of data.merchants) {
		if (!validatePubkey(pubkey)) throw new Error(`Invalid pubkey format: ${pubkey}`)
	}
	const event = createMarketMerchantsEvent(data, signer, ndk)
	await event.sign(signer)
	await submitAppSettings(event.rawEvent())
	clearMerchantAllowlistCache()
	return event.id
}

const fetchCurrentMerchants = async (appPubkey: string): Promise<string[]> => {
	const currentEvent = await fetchLatestAppEvent({
		kinds: [MERCHANT_ALLOWLIST_KIND],
		authors: [appPubkey],
		'#d': [MERCHANT_ALLOWLIST_DTAG],
	})
	return currentEvent?.tags.filter((t: string[]) => t[0] === 'p' && t[1]).map((t: string[]) => t[1]) || []
}

/** Add a merchant to the allowlist. */
export const addToMarketMerchants = async (merchantPubkey: string, signer: NDKSigner, ndk: NDK, appPubkey?: string): Promise<string> => {
	const currentUser = await signer.user()
	if (!currentUser?.pubkey) throw new Error('Unable to get current user pubkey')
	const targetAppPubkey = appPubkey || currentUser.pubkey

	const current = await fetchCurrentMerchants(targetAppPubkey)
	if (current.includes(merchantPubkey)) throw new Error('Merchant is already on the allowlist')
	return publishMarketMerchants({ merchants: [...current, merchantPubkey] }, signer, ndk)
}

/** Remove a merchant from the allowlist. */
export const removeFromMarketMerchants = async (
	merchantPubkey: string,
	signer: NDKSigner,
	ndk: NDK,
	appPubkey?: string,
): Promise<string> => {
	const currentUser = await signer.user()
	if (!currentUser?.pubkey) throw new Error('Unable to get current user pubkey')
	const targetAppPubkey = appPubkey || currentUser.pubkey

	const current = await fetchCurrentMerchants(targetAppPubkey)
	if (!current.includes(merchantPubkey)) throw new Error('Merchant is not on the allowlist')
	return publishMarketMerchants({ merchants: current.filter((pk) => pk !== merchantPubkey) }, signer, ndk)
}

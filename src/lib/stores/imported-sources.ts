/**
 * Imported market sources — a viewer's OWN, device-local list of merchant/store
 * pubkeys they want to browse in addition to the admin market.
 *
 * This scope is deliberately isolated:
 *  - It lives only in this browser's localStorage. It is NEVER published to any
 *    relay, so importing a source cannot leak into the shared market or into
 *    another visitor's view (non-federating).
 *  - Its listings are shown on a SEPARATE surface (the `/imported` route), never
 *    meshed into the admin-scoped catalog.
 */
import { Store } from '@tanstack/store'
import { nip19 } from 'nostr-tools'

const STORAGE_KEY = 'magick_imported_sources_v1'

const hasLocalStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

const load = (): string[] => {
	if (!hasLocalStorage()) return []
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
	} catch {
		return []
	}
}

const save = (sources: string[]) => {
	if (!hasLocalStorage()) return
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(sources))
	} catch (e) {
		console.error('Failed to persist imported sources:', e)
	}
}

export interface ImportedSourcesState {
	sources: string[] // hex pubkeys
}

export const importedSourcesStore = new Store<ImportedSourcesState>({ sources: load() })

/** Normalise an npub / nprofile / hex input to a hex pubkey, or throw. */
export const resolveSourcePubkey = (input: string): string => {
	const value = input.trim()
	if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
	if (value.startsWith('npub1')) {
		const { type, data } = nip19.decode(value)
		if (type === 'npub') return data as string
		throw new Error('Invalid npub')
	}
	if (value.startsWith('nprofile1')) {
		const { type, data } = nip19.decode(value)
		if (type === 'nprofile') return (data as { pubkey: string }).pubkey
		throw new Error('Invalid nprofile')
	}
	throw new Error('Enter an npub, nprofile, or 64-char hex pubkey')
}

export const importedSourcesActions = {
	list: (): string[] => importedSourcesStore.state.sources,

	/** Add a source by npub / nprofile / hex. Returns the resolved hex pubkey. */
	add: (input: string): string => {
		const pubkey = resolveSourcePubkey(input)
		const current = importedSourcesStore.state.sources
		if (!current.includes(pubkey)) {
			const next = [...current, pubkey]
			importedSourcesStore.setState(() => ({ sources: next }))
			save(next)
		}
		return pubkey
	},

	remove: (pubkey: string) => {
		const next = importedSourcesStore.state.sources.filter((pk) => pk !== pubkey)
		importedSourcesStore.setState(() => ({ sources: next }))
		save(next)
	},
}

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils.js'
import { GoblinSessionChannel } from '@/lib/goblin/session/GoblinSessionChannel'
import { conversationKey, generateChannelKeypair, sealEnvelope, unixNow, type SignRequestPayload } from '@/lib/goblin/session/protocol'
import {
	ABSOLUTE_CAP_MS,
	GOBLIN_SESSION_WINDOW_KEY,
	IDLE_TIMEOUT_MS,
	loadPersistedSession,
	PERSISTED_SESSION_VERSION,
	savePersistedSession,
	type PersistedGoblinSession,
} from '@/lib/goblin/session/sessionWindow'
import { goblinSessionActions, goblinSessionStore } from '@/lib/stores/goblinSession'
import { ndkActions } from '@/lib/stores/ndk'

class MemoryStorage {
	private s = new Map<string, string>()
	getItem(k: string) {
		return this.s.has(k) ? this.s.get(k)! : null
	}
	setItem(k: string, v: string) {
		this.s.set(k, v)
	}
	removeItem(k: string) {
		this.s.delete(k)
	}
	clear() {
		this.s.clear()
	}
}

// A stable channel keypair + identity so the persisted record is coherent.
const siteKeys = generateChannelKeypair()
const walletKeys = generateChannelKeypair()
const identityPriv = new Uint8Array(32).fill(9)
const identityPub = getPublicKey(identityPriv)

function persistedSession(overrides: Partial<PersistedGoblinSession> = {}): PersistedGoblinSession {
	const now = Date.now()
	return {
		v: PERSISTED_SESSION_VERSION,
		siteSessionPrivateKey: bytesToHex(siteKeys.privateKey),
		walletSessionPubkey: walletKeys.publicKey,
		identityPubkey: identityPub,
		// No relays: the resumed channel then opens zero sockets, so the restore path
		// is fully network-free in a unit test while still exercising resume().
		relays: [],
		authorizedAt: now,
		lastActivityAt: now,
		...overrides,
	}
}

describe('goblinSessionActions.restore gating', () => {
	beforeEach(() => {
		;(globalThis as any).localStorage = new MemoryStorage()
		goblinSessionActions.teardownLocal()
		goblinSessionStore.setState(() => ({ status: 'idle', domain: null, identityPubkey: null, pendingConfirmCount: 0, endedReason: null }))
	})
	afterEach(() => {
		goblinSessionActions.endActiveSession('logout')
	})

	test('returns null when there is no persisted session', () => {
		expect(goblinSessionActions.restore()).toBeNull()
	})

	test('wipes and returns null when the idle clock has expired', () => {
		const now = Date.now()
		savePersistedSession(persistedSession({ authorizedAt: now - 10 * 60_000, lastActivityAt: now - (IDLE_TIMEOUT_MS + 60_000) }))
		expect(goblinSessionActions.restore()).toBeNull()
		expect(loadPersistedSession()).toBeNull() // wiped
		expect(localStorage.getItem(GOBLIN_SESSION_WINDOW_KEY)).toBeNull()
		expect(goblinSessionActions.isActive()).toBe(false)
	})

	test('wipes and returns null when the absolute cap has expired', () => {
		const now = Date.now()
		// Active right up to now, but authorized more than 8h ago.
		savePersistedSession(persistedSession({ authorizedAt: now - (ABSOLUTE_CAP_MS + 60_000), lastActivityAt: now }))
		expect(goblinSessionActions.restore()).toBeNull()
		expect(loadPersistedSession()).toBeNull() // wiped
		expect(goblinSessionActions.isActive()).toBe(false)
	})

	test('restores a live session: rebinds the channel and exposes a signer with canSign capability', () => {
		savePersistedSession(persistedSession())
		const restored = goblinSessionActions.restore()
		expect(restored).not.toBeNull()
		expect(restored!.identityPubkey).toBe(identityPub)
		expect(restored!.signer.pubkey).toBe(identityPub)
		// The session is live and the store reflects an active session.
		expect(goblinSessionActions.isActive()).toBe(true)
		expect(goblinSessionStore.state.status).toBe('active')
		expect(goblinSessionStore.state.identityPubkey).toBe(identityPub)
		// The persisted record survives a successful restore (still resumable).
		expect(loadPersistedSession()).not.toBeNull()
	})

	test('endActiveSession after a restore wipes the persisted record completely', () => {
		savePersistedSession(persistedSession())
		goblinSessionActions.restore()
		goblinSessionActions.endActiveSession('expired')
		expect(loadPersistedSession()).toBeNull()
		expect(goblinSessionActions.isActive()).toBe(false)
		expect(goblinSessionStore.state.status).toBe('idle')
	})
})

/**
 * The channel resume() seam is what makes the restore work without a fresh
 * handshake: it rebinds directly to the persisted wallet session key and then
 * signs end to end. Driven in-memory (injected publish + hand-fed envelopes).
 */
describe('GoblinSessionChannel.resume', () => {
	test('a resumed channel signs without waiting for a fresh session-open', async () => {
		const published: { event: any }[] = []
		const channel = new GoblinSessionChannel({
			siteSessionKeys: siteKeys,
			relays: [],
			publish: (_relays, event) => published.push({ event }),
			requestTimeoutMs: 500,
		})
		// Rebind to the known wallet session key (what restore() persists).
		channel.resume({ walletSessionPubkey: walletKeys.publicKey, identityPubkey: identityPub })
		expect(channel.walletPubkey).toBe(walletKeys.publicKey)
		expect(channel.identity).toBe(identityPub)

		const convKey = conversationKey(walletKeys.privateKey, siteKeys.publicKey)
		const pinned = unixNow() - 3
		const signPromise = channel.sign({ pubkey: identityPub, created_at: pinned, kind: 1, tags: [], content: 'resumed' })

		// Read the site->wallet request, sign it as the wallet, feed the result back.
		const reqEvent = published[0].event
		const reqPayload = JSON.parse((await import('nostr-tools')).nip44.v2.decrypt(reqEvent.content, convKey)) as SignRequestPayload
		expect(reqPayload.type).toBe('sign')
		const signed = finalizeEvent(
			{
				kind: reqPayload.event.kind,
				created_at: reqPayload.event.created_at,
				tags: reqPayload.event.tags,
				content: reqPayload.event.content,
			},
			identityPriv,
		)
		channel.handleEnvelope(
			sealEnvelope({
				payload: { type: 'sign_result', id: reqPayload.id, ok: true, event: signed },
				senderPrivateKey: walletKeys.privateKey,
				recipientPublicKey: siteKeys.publicKey,
				convKey,
			}),
		)

		const result = await signPromise
		expect(result.pubkey).toBe(identityPub)
		expect(result.created_at).toBe(pinned)
	})

	test('resume is a no-op once the channel is already bound', () => {
		const channel = new GoblinSessionChannel({ siteSessionKeys: siteKeys, relays: [], publish: () => {} })
		channel.resume({ walletSessionPubkey: walletKeys.publicKey, identityPubkey: identityPub })
		const otherWallet = generateChannelKeypair()
		channel.resume({ walletSessionPubkey: otherWallet.publicKey, identityPubkey: 'd'.repeat(64) })
		expect(channel.walletPubkey).toBe(walletKeys.publicKey) // unchanged
		expect(channel.identity).toBe(identityPub)
	})
})

// Keep the ndk import referenced (restore reads relays from the record, not the
// live relay, but the store module imports ndk; assert the seam stays wired).
test('ndk store is importable alongside the session store', () => {
	expect(typeof ndkActions.getNDK).toBe('function')
	spyOn(ndkActions, 'getNDK')
		.mockReturnValue(null as never)
		.mockRestore()
})

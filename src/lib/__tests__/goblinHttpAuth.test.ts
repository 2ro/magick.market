import { describe, expect, test } from 'bun:test'
import { NDKUser, type NDKSigner } from '@nostr-dev-kit/ndk'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools'
import type { Event } from 'nostr-tools'
import { BLOSSOM_AUTH_KIND, buildBlossomAuth, buildNip98Auth, NIP98_HTTP_AUTH_KIND, toNostrAuthHeader } from '@/lib/goblin/session/httpAuth'

const priv = new Uint8Array(32).fill(5)
const pub = getPublicKey(priv)

/** A signer standing in for the GoblinAuthorizeSigner (any NDKSigner works). */
function fakeSigner(): NDKSigner {
	const user = new NDKUser({ pubkey: pub })
	return {
		pubkey: pub,
		userSync: user,
		async blockUntilReady() {
			return user
		},
		async user() {
			return user
		},
		async sign(event: { kind: number; created_at: number; tags: string[][]; content: string }) {
			const ev = finalizeEvent({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content }, priv)
			return ev.sig
		},
		async encrypt() {
			return ''
		},
		async decrypt() {
			return ''
		},
		toPayload() {
			return ''
		},
	} as unknown as NDKSigner
}

function decodeHeader(header: string): Event {
	expect(header.startsWith('Nostr ')).toBe(true)
	const b64 = header.slice('Nostr '.length)
	const json = typeof atob === 'function' ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, 'base64').toString('utf-8')
	return JSON.parse(json) as Event
}

describe('goblin session HTTP-auth builders (spec 5.7)', () => {
	test('buildNip98Auth composes a verifiable kind 27235 event and Nostr header', async () => {
		const { event, header } = await buildNip98Auth({
			signer: fakeSigner(),
			url: 'https://magick.market/upload',
			method: 'post',
			payloadSha256: 'a'.repeat(64),
			createdAt: 1_751_800_000,
		})
		expect(event.kind).toBe(NIP98_HTTP_AUTH_KIND)
		expect(event.pubkey).toBe(pub)
		expect(event.created_at).toBe(1_751_800_000)
		expect(event.tags).toContainEqual(['u', 'https://magick.market/upload'])
		expect(event.tags).toContainEqual(['method', 'POST'])
		expect(event.tags).toContainEqual(['payload', 'a'.repeat(64)])
		expect(verifyEvent(event)).toBe(true)
		expect(decodeHeader(header).id).toBe(event.id)
	})

	test('buildBlossomAuth composes a verifiable kind 24242 event with t/x/expiration', async () => {
		const { event, header } = await buildBlossomAuth({
			signer: fakeSigner(),
			verb: 'upload',
			sha256: 'b'.repeat(64),
			createdAt: 1_751_800_000,
			expirationSeconds: 300,
		})
		expect(event.kind).toBe(BLOSSOM_AUTH_KIND)
		expect(event.tags).toContainEqual(['t', 'upload'])
		expect(event.tags).toContainEqual(['x', 'b'.repeat(64)])
		expect(event.tags).toContainEqual(['expiration', String(1_751_800_000 + 300)])
		expect(verifyEvent(event)).toBe(true)
		expect(decodeHeader(header).sig).toBe(event.sig)
	})

	test('toNostrAuthHeader is the base64 of the signed event JSON', () => {
		const ev = finalizeEvent({ kind: 27235, created_at: 1, tags: [], content: '' }, priv)
		expect(decodeHeader(toNostrAuthHeader(ev)).id).toBe(ev.id)
	})
})

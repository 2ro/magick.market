import { describe, test, expect } from 'bun:test'
import { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { base64Encode, buildNip98AuthHeader, buildNip98Tags, NIP98_KIND, payloadHashHex } from '@/lib/nip98'

function decodeBase64ToString(b64: string): string {
	if (typeof atob === 'function') {
		const binary = atob(b64)
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return new TextDecoder().decode(bytes)
	}
	return Buffer.from(b64, 'base64').toString('utf-8')
}

describe('payloadHashHex', () => {
	test('is the lowercase hex sha256 of the body bytes', () => {
		const body = '{"offer_id":"abc"}'
		expect(payloadHashHex(body)).toBe(bytesToHex(sha256(utf8ToBytes(body))))
		expect(payloadHashHex(body)).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('buildNip98Tags', () => {
	test('u + method (uppercased), no payload without a body', () => {
		const tags = buildNip98Tags('https://goblin.st/api/v1/transfer/offer/abc', 'delete')
		expect(tags).toEqual([
			['u', 'https://goblin.st/api/v1/transfer/offer/abc'],
			['method', 'DELETE'],
		])
	})

	test('adds a payload tag with the body hash when a body is present', () => {
		const body = '{"x":1}'
		const tags = buildNip98Tags('https://goblin.st/api/v1/transfer/claim', 'POST', body)
		expect(tags).toContainEqual(['u', 'https://goblin.st/api/v1/transfer/claim'])
		expect(tags).toContainEqual(['method', 'POST'])
		expect(tags).toContainEqual(['payload', payloadHashHex(body)])
	})
})

describe('base64Encode', () => {
	test('round-trips a UTF-8 string', () => {
		const s = '{"content":"café ☕"}'
		expect(decodeBase64ToString(base64Encode(s))).toBe(s)
	})
})

describe('buildNip98AuthHeader', () => {
	test('signs a kind-27235 event with u/method/payload and round-trips through NDK', async () => {
		const signer = NDKPrivateKeySigner.generate()
		const user = await signer.user()
		const url = 'https://goblin.st/api/v1/transfer/claim'
		const body = JSON.stringify({ offer_id: 'a'.repeat(64), proof: { amount: '1' } })

		const header = await buildNip98AuthHeader({ signer, url, method: 'POST', body })
		expect(header.startsWith('Nostr ')).toBe(true)

		const json = JSON.parse(decodeBase64ToString(header.slice('Nostr '.length)))
		expect(json.kind).toBe(NIP98_KIND)
		expect(json.kind).toBe(27235)
		expect(json.content).toBe('')
		expect(json.pubkey).toBe(user.pubkey)

		const tags: string[][] = json.tags
		expect(tags).toContainEqual(['u', url])
		expect(tags).toContainEqual(['method', 'POST'])
		expect(tags).toContainEqual(['payload', payloadHashHex(body)])

		// created_at is fresh (within a minute of now).
		expect(Math.abs(json.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(60)

		// The signature verifies as a genuine NDK event by the acting key.
		const event = new NDKEvent(undefined, json)
		expect(await event.verifySignature(true)).toBe(true)
	})

	test('omits the payload tag when there is no body (DELETE)', async () => {
		const signer = NDKPrivateKeySigner.generate()
		const url = 'https://goblin.st/api/v1/transfer/offer/deadbeef'
		const header = await buildNip98AuthHeader({ signer, url, method: 'DELETE' })
		const json = JSON.parse(decodeBase64ToString(header.slice('Nostr '.length)))
		expect(json.tags).toContainEqual(['method', 'DELETE'])
		expect(json.tags.find((t: string[]) => t[0] === 'payload')).toBeUndefined()
	})
})

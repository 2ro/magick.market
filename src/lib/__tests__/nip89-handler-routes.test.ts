import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createHandlerInfoEventData, MAGICK_MARKET_URL } from '@/publish/nip89'

/**
 * Guards against the "emitted link vs registered route" class of bug: a NIP-89
 * handler URL (or any generated deep link) that points at a path the router
 * does not register 404s for anyone who follows it. Historically the handler
 * emitted the singular `/product/<bech32>` (and a dead `/a/<bech32>`), neither
 * of which is a real route. This test derives the registered route set from the
 * generated route tree and asserts every emitted handler URL resolves to one.
 */

const routeTree = readFileSync(join(import.meta.dir, '../../routeTree.gen.ts'), 'utf8')
const registeredPaths = Array.from(routeTree.matchAll(/fullPath: '([^']*)'/g)).map((m) => m[1])

// Turn a registered path pattern (e.g. /products/$productId) into a matcher that
// treats `$param` segments as wildcards and tolerates an optional trailing slash.
const toMatcher = (p: string) => new RegExp('^' + p.replace(/\$[^/]+/g, '[^/]+').replace(/\/$/, '/?') + '$')
const pathMatchesRoute = (path: string) => registeredPaths.some((r) => toMatcher(r).test(path))

describe('nip89 handler URLs point to registered routes', () => {
	const event = createHandlerInfoEventData('deadbeef', {}, undefined, 'handler-1')
	const webTags = event.tags.filter((t) => t[0] === 'web')
	// Replace the <bech32> placeholder with a concrete-looking id so the path can
	// be matched against a `$param` route segment.
	const paths = webTags.map((t) => t[1].replace(MAGICK_MARKET_URL, '').replace('<bech32>', 'placeholderid'))

	test('emits at least one handler URL', () => {
		expect(webTags.length).toBeGreaterThan(0)
	})

	test('every emitted handler URL resolves to a registered route', () => {
		expect(registeredPaths).toContain('/products/$productId')
		for (const path of paths) {
			expect({ path, resolves: pathMatchesRoute(path) }).toEqual({ path, resolves: true })
		}
	})

	test('does not emit the legacy singular /product/ or dead /a/ handler paths', () => {
		for (const tag of webTags) {
			expect(tag[1]).not.toContain('/product/<')
			expect(tag[1]).not.toContain('/a/<')
		}
	})
})

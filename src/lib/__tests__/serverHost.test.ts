import { describe, test, expect } from 'bun:test'
import { resolveListenHost } from '@/lib/serverHost'

describe('resolveListenHost — production binds loopback', () => {
	test('production with no HOST → 127.0.0.1 (behind the nginx TLS proxy)', () => {
		expect(resolveListenHost({ NODE_ENV: 'production' })).toBe('127.0.0.1')
	})
	test('development with no HOST → 0.0.0.0 (LAN device testing)', () => {
		expect(resolveListenHost({ NODE_ENV: 'development' })).toBe('0.0.0.0')
	})
	test('unset NODE_ENV defaults to 0.0.0.0 (treated as non-production)', () => {
		expect(resolveListenHost({})).toBe('0.0.0.0')
	})
	test('explicit HOST always wins, even in production', () => {
		expect(resolveListenHost({ NODE_ENV: 'production', HOST: '0.0.0.0' })).toBe('0.0.0.0')
		expect(resolveListenHost({ NODE_ENV: 'development', HOST: '127.0.0.1' })).toBe('127.0.0.1')
	})
	test('whitespace-only HOST is ignored (falls back to the env default)', () => {
		expect(resolveListenHost({ NODE_ENV: 'production', HOST: '   ' })).toBe('127.0.0.1')
	})
	test('explicit HOST is trimmed', () => {
		expect(resolveListenHost({ NODE_ENV: 'production', HOST: ' 10.0.0.5 ' })).toBe('10.0.0.5')
	})
})

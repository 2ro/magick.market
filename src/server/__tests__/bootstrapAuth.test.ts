import { describe, test, expect } from 'bun:test'
import { getPublicKey } from 'nostr-tools'
import type { NostrEvent } from '@nostr-dev-kit/ndk'
import { AdminManagerImpl } from '../AdminManager'
import { EditorManagerImpl } from '../EditorManager'
import { BootstrapManagerImpl } from '../BootstrapManager'
import { EventValidator } from '../EventValidator'
import { bytesFromHex } from '@/lib/utils/keyConversion'

// A valid app private key so validateSetupEvent can derive the app pubkey.
const APP_PRIVATE_KEY = '01'.repeat(32)
const APP_PUBKEY = getPublicKey(bytesFromHex(APP_PRIVATE_KEY))
const OWNER = 'a'.repeat(64)
const ATTACKER = 'f'.repeat(64)

const adminListEvent = (author: string, listed: string[]): NostrEvent =>
	({
		kind: 30000,
		pubkey: author,
		created_at: Math.floor(Date.now() / 1000),
		content: '',
		tags: [['d', 'admins'], ...listed.map((pk) => ['p', pk])],
	}) as unknown as NostrEvent

const setupEvent = (author: string): NostrEvent =>
	({
		kind: 31990,
		pubkey: author,
		created_at: Math.floor(Date.now() / 1000),
		content: JSON.stringify({ name: 'My Market', ownerPk: author }),
		tags: [],
	}) as unknown as NostrEvent

// Wire the managers the way EventHandler.initialize does (config admin list is
// always empty), then simulate the relay-restore + reconcile step under test.
function makeValidator(restoredAdmins: string[]) {
	const adminManager = new AdminManagerImpl([]) // config always passes []
	const editorManager = new EditorManagerImpl()
	const bootstrapManager = new BootstrapManagerImpl(adminManager, 0) // initialAdminCount 0 → bootstrap
	// loadExistingData() would repopulate adminManager from the relay:
	restoredAdmins.forEach((pk) => adminManager.addAdmin(pk))
	// The fix: reconcile bootstrap against the restored admin count.
	bootstrapManager.reconcileFromAdminCount(adminManager.size())
	const validator = new EventValidator(APP_PRIVATE_KEY, adminManager, editorManager, bootstrapManager)
	return { adminManager, bootstrapManager, validator }
}

describe('BootstrapManager.reconcileFromAdminCount', () => {
	test('fresh instance (no restored admins) STAYS in bootstrap mode', () => {
		const { bootstrapManager } = makeValidator([])
		expect(bootstrapManager.isBootstrapMode()).toBe(true)
	})
	test('established instance (admins restored from relay) LEAVES bootstrap mode', () => {
		const { bootstrapManager } = makeValidator([OWNER])
		expect(bootstrapManager.isBootstrapMode()).toBe(false)
	})
	test('is idempotent and never re-opens bootstrap once closed', () => {
		const { bootstrapManager } = makeValidator([OWNER])
		bootstrapManager.reconcileFromAdminCount(0) // a later empty read must not reopen
		expect(bootstrapManager.isBootstrapMode()).toBe(false)
	})
})

describe('SECURITY: restarted established instance rejects anonymous takeover', () => {
	test('anonymous admin-list event is REJECTED after reconcile (the fix)', () => {
		const { validator } = makeValidator([OWNER])
		const res = validator.validateEvent(adminListEvent(ATTACKER, [ATTACKER]))
		expect(res.isValid).toBe(false)
	})
	test('anonymous setup event is REJECTED after reconcile', () => {
		const { validator } = makeValidator([OWNER])
		const res = validator.validateEvent(setupEvent(ATTACKER))
		expect(res.isValid).toBe(false)
	})
	test('the real admin can still publish an admin list', () => {
		const { validator } = makeValidator([OWNER])
		expect(validator.validateEvent(adminListEvent(OWNER, [OWNER, 'b'.repeat(64)])).isValid).toBe(true)
	})
	test('the app key can still publish a setup event', () => {
		const { validator } = makeValidator([OWNER])
		expect(validator.validateEvent(setupEvent(APP_PUBKEY)).isValid).toBe(true)
	})
})

describe('first-run bootstrap still works on a genuinely fresh instance', () => {
	test('bootstrap mode accepts the first admin-list / setup event from anyone', () => {
		const { validator } = makeValidator([]) // no admins restored → still bootstrap
		expect(validator.validateEvent(adminListEvent(OWNER, [OWNER])).isValid).toBe(true)
		expect(validator.validateEvent(setupEvent(OWNER)).isValid).toBe(true)
	})
})

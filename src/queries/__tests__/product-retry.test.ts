import { describe, expect, it } from 'bun:test'
import { MAX_PRODUCT_FETCH_RETRIES, ProductUnavailableError, shouldRetryProductFetch } from '../products'

// Regression coverage for the "Loading product… forever" deep-link bug.
//
// A shared deep link whose kind-30402 event id is no longer on the relay (an
// addressable listing replaced/republished under a new id, or a truly absent id)
// makes fetchProduct throw a plain Error on every attempt. The retry predicate
// MUST bound those retries so the route resolves to "Product not found" instead
// of spinning indefinitely — while still never retrying a permanent
// ProductUnavailableError (non-GRIN / out-of-scope listing).
describe('shouldRetryProductFetch', () => {
	it('never retries a permanent ProductUnavailableError, even on the first failure', () => {
		const err = new ProductUnavailableError()
		expect(shouldRetryProductFetch(0, err)).toBe(false)
		expect(shouldRetryProductFetch(3, err)).toBe(false)
		expect(shouldRetryProductFetch(999, err)).toBe(false)
	})

	it('retries a transient "not on the relay yet" miss while under the cap', () => {
		const miss = new Error('Product not found')
		expect(shouldRetryProductFetch(0, miss)).toBe(true)
		expect(shouldRetryProductFetch(MAX_PRODUCT_FETCH_RETRIES - 1, miss)).toBe(true)
	})

	it('gives up once the retry cap is reached, so a stale/absent id resolves to not-found', () => {
		const miss = new Error('Product not found')
		expect(shouldRetryProductFetch(MAX_PRODUCT_FETCH_RETRIES, miss)).toBe(false)
		expect(shouldRetryProductFetch(MAX_PRODUCT_FETCH_RETRIES + 50, miss)).toBe(false)
	})

	it('keeps the retry budget small and bounded', () => {
		expect(MAX_PRODUCT_FETCH_RETRIES).toBeGreaterThan(0)
		expect(MAX_PRODUCT_FETCH_RETRIES).toBeLessThanOrEqual(10)
	})
})

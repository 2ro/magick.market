import { z } from 'zod'

export const addressableFormat = z.string().regex(/^\d+:[0-9a-f]{64}:[a-zA-Z0-9_-]+$/, 'Must be in format kind:pubkey:d-identifier')
export const hexString = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-character hex string')
// magick.market is GRIN-only: price tags may only be denominated in GRIN. This literal
// enforces the invariant at the write/validation boundary so the app can never author a
// non-GRIN listing; market-scope.ts drops any foreign-priced listing on read as defense-in-depth.
export const grinCurrency = z.literal('GRIN')
export const iso3166Country = z.string().regex(/^[A-Z]{2}$/, 'Must be an ISO 3166-1 alpha-2 country code')
export const iso3166Region = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'Must be an ISO 3166-2 region code')
export const iso8601Duration = z.enum(['H', 'D', 'W', 'M', 'Y'])
export const geohash = z.string().regex(/^[0-9a-z]{1,12}$/, 'Must be a valid geohash')

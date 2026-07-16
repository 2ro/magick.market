/**
 * Resolve the network interface the bun app server binds to.
 *
 * SECURITY: in production the app sits behind an nginx TLS reverse proxy that
 * forwards to 127.0.0.1:<PORT>. If the app binds 0.0.0.0 (bun's default) the raw
 * HTTP port also answers the public internet directly, bypassing TLS and any
 * proxy-level controls (verified live: the plaintext port returned 200 on the
 * public IP). Binding to loopback in production forces all traffic through the
 * proxy. An explicit HOST env always wins (e.g. a deployment that fronts the app
 * differently); otherwise default to loopback in production and all-interfaces in
 * dev so local device testing over the LAN keeps working. Pure — safe to unit-test.
 */
export function resolveListenHost(env: { HOST?: string; NODE_ENV?: string } = process.env): string {
	const explicit = typeof env.HOST === 'string' ? env.HOST.trim() : ''
	if (explicit) return explicit
	return env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'
}

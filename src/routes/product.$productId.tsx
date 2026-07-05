import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Legacy alias for the singular `/product/$productId` path inherited from
 * Plebeian Market. The canonical route is `/products/$productId` (plural).
 *
 * Old shared links and any externally published NIP-89 handler URLs that still
 * use the singular form must keep resolving, so this route permanently
 * redirects to the canonical plural path, preserving the id param.
 */
export const Route = createFileRoute('/product/$productId')({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: '/products/$productId',
			params: { productId: params.productId },
			replace: true,
		})
	},
})

import { createContext, useContext, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * Context that tracks whether a subtree is wrapped by ThemeMigrationWrapper.
 *
 * Portalled content (dialogs, popovers, tooltips) renders outside the
 * `.theme-new` DOM scope, so it does not inherit the scoped CSS custom
 * properties. Consumers can call `useThemeMigration()` to check whether
 * they are inside a migrated subtree and, if so, apply the `theme-new`
 * class to portalled content elements (e.g. `DialogContent`,
 * `PopoverContent`, `TooltipContent`) so the scoped tokens apply.
 */
const ThemeMigrationContext = createContext<string | null>(null)

/**
 * Returns the theme class name (`"theme-new"`) when inside a
 * `ThemeMigrationWrapper`, or `null` when outside. Use this to apply
 * the scoped theme to portalled content that would otherwise escape
 * the `.theme-new` DOM boundary.
 *
 * @example
 * const themeClass = useThemeMigration()
 * <DialogContent className={cn(themeClass, '...')}>
 */
export function useThemeMigration(): string | null {
	return useContext(ThemeMigrationContext)
}

/**
 * ThemeMigrationWrapper — opts a subtree into the `.theme-new` token scope.
 *
 * Wrapping a subtree in this component applies the `theme-new` CSS class,
 * which redefines all design tokens (colors, fonts, radii) for that subtree
 * only. This enables slice-by-slice migration: migrated UI uses the new
 * token system while unmigrated UI continues using the legacy `:root` tokens
 * from `globals.css`. Both can coexist on the same page without conflict.
 *
 * Usage:
 *   <ThemeMigrationWrapper>{children}</ThemeMigrationWrapper>
 *
 * The wrapper renders a plain `<div>` with the `theme-new` class. When the
 * entire app is migrated, the wrapper can be moved to the root layout and the
 * legacy `:root` token block removed from `globals.css`.
 *
 * ## Portal handling
 *
 * Radix UI portals (used by Shadcn dialogs, popovers, tooltips) render their
 * content to `document.body` by default, which is **outside** the
 * `.theme-new` DOM scope. As a result, portalled content does not inherit
 * the scoped CSS custom properties and will fall back to the legacy
 * `:root` tokens.
 *
 * To fix this, call `useThemeMigration()` inside portalled components and
 * apply the returned class name to the portalled content element:
 *
 * ```tsx
 * const themeClass = useThemeMigration()
 * <DialogContent className={cn(themeClass, 'bg-background text-foreground')}>
 * ```
 *
 * This re-establishes the scoped token boundary for the portalled subtree.
 * When the entire app is eventually wrapped, the portal issue disappears
 * naturally because all content — portalled or not — will be inside the
 * global `.theme-new` scope.
 *
 * @see docs/adr/ADR-component-ui-migration-and-widget-book.md §1a, §2b
 */
export function ThemeMigrationWrapper({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<ThemeMigrationContext.Provider value="theme-new">
			<div className={cn('theme-new', className)} {...props}>
				{children}
			</div>
		</ThemeMigrationContext.Provider>
	)
}

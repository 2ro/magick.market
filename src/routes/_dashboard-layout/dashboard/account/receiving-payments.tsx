import { DashboardListItem } from '@/components/layout/DashboardListItem'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { PAYMENT_DETAILS_METHOD, type PaymentDetailsMethod } from '@/lib/constants'
import { isValidGoblinPayAddress } from '@/lib/grin'
import { useNDK } from '@/lib/stores/ndk'
import { getCollectionId, getCollectionTitle, useCollectionsByPubkey } from '@/queries/collections'
import {
	useDeletePaymentDetail,
	usePublishRichPaymentDetail,
	useRichUserPaymentDetails,
	useUpdatePaymentDetail,
	type PaymentScope,
	type RichPaymentDetail,
} from '@/queries/payment'
import { getProductId, getProductTitle, useProductsByPubkey } from '@/queries/products'
import { useDashboardTitle } from '@/routes/_dashboard-layout'
import { createFileRoute } from '@tanstack/react-router'
import { ClipboardIcon, GlobeIcon, PackageIcon, PlusIcon, StarIcon, StoreIcon, TrashIcon, WalletIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

const paymentMethodLabels: Record<PaymentDetailsMethod, string> = {
	[PAYMENT_DETAILS_METHOD.GRIN]: 'Goblin (GRIN)',
}

interface ScopeSelectorProps {
	value: PaymentScope
	scopeId?: string | null
	scopeIds?: string[] // For multi-product selection
	userPubkey: string
	onChange: (scope: PaymentScope, scopeId: string | null, scopeName: string, scopeIds?: string[]) => void
}

function ScopeSelector({ value, scopeId, scopeIds, userPubkey, onChange }: ScopeSelectorProps) {
	const productsQuery = useProductsByPubkey(userPubkey, true) // Include hidden products for payment scope selection
	const collectionsQuery = useCollectionsByPubkey(userPubkey)
	const [selectedProducts, setSelectedProducts] = useState<string[]>(scopeIds || [])
	const [isProductSelectorOpen, setIsProductSelectorOpen] = useState(false)

	const handleScopeChange = (newValue: string) => {
		if (newValue === 'global') {
			setSelectedProducts([])
			onChange('global', null, 'Global', [])
		} else if (newValue === 'collection:') {
			// This triggers the collection selector mode
			setSelectedProducts([])
		} else if (newValue === 'product:') {
			// This triggers the multi-product selector mode
			setIsProductSelectorOpen(true)
		} else if (newValue.startsWith('collection:')) {
			const collectionId = newValue.replace('collection:', '')
			const collection = collectionsQuery.data?.find((c) => getCollectionId(c) === collectionId)
			if (collection) {
				setSelectedProducts([])
				onChange('collection', collectionId, getCollectionTitle(collection), [])
			}
		}
	}

	const handleProductToggle = (productId: string) => {
		setSelectedProducts((prev) => {
			const newSelection = prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]

			// Update parent with the new selection
			if (newSelection.length > 0) {
				const productNames = newSelection
					.map((id) => {
						const product = productsQuery.data?.find((p) => getProductId(p) === id)
						return product ? getProductTitle(product) : null
					})
					.filter(Boolean)

				const scopeName = newSelection.length === 1 ? productNames[0]! : `${newSelection.length} Products`

				onChange('product', newSelection[0], scopeName, newSelection)
			}

			return newSelection
		})
	}

	const getCurrentValue = () => {
		if (value === 'global') return 'global'
		if (value === 'collection' && scopeId) return `collection:${scopeId}`
		if (value === 'product' && selectedProducts.length > 0) return 'product:'
		return 'global'
	}

	const getDisplayText = () => {
		if (value === 'global') return 'Global - All products'
		if (value === 'collection' && scopeId) {
			const collection = collectionsQuery.data?.find((c) => getCollectionId(c) === scopeId)
			return collection ? `Collection: ${getCollectionTitle(collection)}` : 'Collection'
		}
		if (value === 'product' && selectedProducts.length > 0) {
			if (selectedProducts.length === 1) {
				const product = productsQuery.data?.find((p) => getProductId(p) === selectedProducts[0])
				return product ? `Product: ${getProductTitle(product)}` : '1 Product'
			}
			return `${selectedProducts.length} Products selected`
		}
		return 'Select scope'
	}

	return (
		<div className="space-y-2">
			<Select value={getCurrentValue()} onValueChange={handleScopeChange}>
				<SelectTrigger>
					<SelectValue placeholder="Select scope">{getDisplayText()}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="global">
						<div className="flex items-center gap-2">
							<GlobeIcon className="w-5 h-5" />
							Global (All Products)
						</div>
					</SelectItem>

					{collectionsQuery.data && collectionsQuery.data.length > 0 && (
						<>
							<div className="px-2 py-1 text-xs font-medium text-muted-foreground">Collections</div>
							{collectionsQuery.data.map((collection) => (
								<SelectItem key={getCollectionId(collection)} value={`collection:${getCollectionId(collection)}`}>
									<div className="flex items-center gap-2">
										<StoreIcon className="w-5 h-5" />
										<span className="truncate max-w-[200px]">{getCollectionTitle(collection)}</span>
									</div>
								</SelectItem>
							))}
						</>
					)}

					{productsQuery.data && productsQuery.data.length > 0 && (
						<>
							<div className="px-2 py-1 text-xs font-medium text-muted-foreground">Products</div>
							<SelectItem value="product:">
								<div className="flex items-center gap-2">
									<PackageIcon className="w-5 h-5" />
									Select Multiple Products...
								</div>
							</SelectItem>
						</>
					)}
				</SelectContent>
			</Select>

			{/* Multi-product selector popover */}
			{isProductSelectorOpen && productsQuery.data && productsQuery.data.length > 0 && (
				<Card className="p-4">
					<div className="flex items-center justify-between mb-3">
						<Label className="font-semibold">Select Products</Label>
						<Button variant="ghost" size="sm" onClick={() => setIsProductSelectorOpen(false)}>
							Done
						</Button>
					</div>
					<div className="space-y-2 max-h-60 overflow-y-auto">
						{productsQuery.data.map((product) => {
							const productId = getProductId(product)
							const isSelected = selectedProducts.includes(productId)
							return (
								<div key={productId} className="flex items-center gap-2">
									<Checkbox id={productId} checked={isSelected} onCheckedChange={() => handleProductToggle(productId)} />
									<Label htmlFor={productId} className="cursor-pointer flex-1">
										{getProductTitle(product)}
									</Label>
								</div>
							)
						})}
					</div>
				</Card>
			)}
		</div>
	)
}

export const Route = createFileRoute('/_dashboard-layout/dashboard/account/receiving-payments')({
	component: ReceivingPaymentsComponent,
})

type FormState = 'idle' | 'validating' | 'submitting'

interface PaymentDetailFormProps {
	paymentDetail: RichPaymentDetail | null
	isOpen: boolean
	onOpenChange: (open: boolean) => void
	onSuccess?: () => void
}

function PaymentDetailForm({ paymentDetail, isOpen, onOpenChange, onSuccess }: PaymentDetailFormProps) {
	const { getUser } = useNDK()
	const [user, setUser] = useState<any>(null)
	const [formState, setFormState] = useState<FormState>('idle')
	const [validationMessage, setValidationMessage] = useState('')

	const publishMutation = usePublishRichPaymentDetail()
	const updateMutation = useUpdatePaymentDetail()
	const deleteMutation = useDeletePaymentDetail()

	const isEditing = !!paymentDetail

	const [editedPaymentDetail, setEditedPaymentDetail] = useState<RichPaymentDetail>(() => {
		if (paymentDetail) {
			return { ...paymentDetail }
		}
		return {
			id: '',
			dTag: '',
			userId: '',
			paymentMethod: PAYMENT_DETAILS_METHOD.GRIN,
			paymentDetail: '',
			scope: 'global',
			scopeId: null,
			scopeName: 'Global',
			isDefault: false,
			createdAt: Date.now(),
		}
	})

	// Get user on mount
	useEffect(() => {
		getUser().then(setUser)
	}, [getUser])

	// Update userId when user changes
	useEffect(() => {
		if (user?.pubkey && !isEditing) {
			setEditedPaymentDetail((prev) => ({ ...prev, userId: user.pubkey }))
		}
	}, [user, isEditing])

	// Reset validation message when dialog closes
	useEffect(() => {
		if (!isOpen) {
			setValidationMessage('')
			setFormState('idle')
		}
	}, [isOpen])

	const resetForm = useCallback(() => {
		setEditedPaymentDetail({
			id: '',
			dTag: '',
			userId: user?.pubkey || '',
			paymentMethod: PAYMENT_DETAILS_METHOD.GRIN,
			paymentDetail: '',
			scope: 'global',
			scopeId: null,
			scopeName: 'Global',
			isDefault: false,
			createdAt: Date.now(),
		})
		setFormState('idle')
		setValidationMessage('')
	}, [user])

	const handleValidateAndConfirm = async (e?: React.FormEvent) => {
		if (e) e.preventDefault()

		if (!editedPaymentDetail.paymentDetail) {
			setValidationMessage('Please fill in your Goblin payment address')
			return
		}

		if (!isValidGoblinPayAddress(editedPaymentDetail.paymentDetail)) {
			setValidationMessage('Enter a Goblin nprofile (nprofile1...), npub, or Grin slatepack address (grin1...)')
			return
		}

		await handleSubmit()
	}

	const handleSubmit = async () => {
		setFormState('submitting')
		setValidationMessage('Saving...')

		try {
			const scopeIds = (editedPaymentDetail as any).scopeIds as string[] | undefined

			// Build coordinates array for multiple products
			let coordinates: string[] = []

			if (editedPaymentDetail.scope === 'collection' && editedPaymentDetail.scopeId && user?.pubkey) {
				coordinates = [`30405:${user.pubkey}:${editedPaymentDetail.scopeId}`]
			} else if (editedPaymentDetail.scope === 'product' && user?.pubkey) {
				// Handle multiple products
				if (scopeIds && scopeIds.length > 0) {
					coordinates = scopeIds.map((productId) => `30402:${user.pubkey}:${productId}`)
				} else if (editedPaymentDetail.scopeId) {
					// Single product
					coordinates = [`30402:${user.pubkey}:${editedPaymentDetail.scopeId}`]
				}
			}

			const payload = {
				paymentMethod: editedPaymentDetail.paymentMethod,
				paymentDetail: editedPaymentDetail.paymentDetail.trim(),
				coordinates: coordinates.length > 0 ? coordinates : undefined,
				scope: editedPaymentDetail.scope,
				scopeId: editedPaymentDetail.scopeId,
				scopeName: editedPaymentDetail.scopeName,
				isDefault: editedPaymentDetail.isDefault,
			}

			if (isEditing) {
				await updateMutation.mutateAsync({
					...payload,
					paymentDetailId: editedPaymentDetail.id,
				})
			} else {
				await publishMutation.mutateAsync(payload as any)
			}

			onOpenChange(false)
			if (!isEditing) resetForm()
			setValidationMessage('')
			onSuccess?.()
		} catch (error) {
			setValidationMessage('An error occurred while saving')
			console.error('Error saving payment method:', error)
		} finally {
			setFormState('idle')
		}
	}

	const handleDelete = () => {
		if (isEditing && editedPaymentDetail.dTag && user?.pubkey) {
			deleteMutation.mutate({
				dTag: editedPaymentDetail.dTag,
				userPubkey: user.pubkey,
			})
			onOpenChange(false)
		}
	}

	const handlePasteFromClipboard = async () => {
		try {
			const text = (await navigator.clipboard.readText()).trim()
			if (isValidGoblinPayAddress(text)) {
				setEditedPaymentDetail((prev) => ({
					...prev,
					paymentDetail: text,
					paymentMethod: PAYMENT_DETAILS_METHOD.GRIN,
				}))
				toast.success('Goblin payment address pasted')
			} else {
				toast.error('Clipboard does not contain a Goblin nprofile or Grin slatepack address')
			}
		} catch (error) {
			toast.error('Failed to read clipboard')
		}
	}

	return (
		<div className="border-t pt-4">
			<form onSubmit={handleValidateAndConfirm} className="space-y-4">
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="space-y-2">
						<Label htmlFor="payment-method" className="font-medium">
							Payment Method
						</Label>
						<Select
							value={editedPaymentDetail.paymentMethod}
							onValueChange={(value: PaymentDetailsMethod) => setEditedPaymentDetail((prev) => ({ ...prev, paymentMethod: value }))}
						>
							<SelectTrigger data-testid="payment-method-selector">
								<SelectValue placeholder="Payment method" />
							</SelectTrigger>
							<SelectContent>
								{Object.values(PAYMENT_DETAILS_METHOD).map((method) => (
									<SelectItem key={method} value={method} data-testid={`payment-method-${method}`}>
										<div className="flex items-center gap-2">
											<WalletIcon className="w-5 h-5" />
											{paymentMethodLabels[method]}
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="scope" className="font-medium">
							Scope
						</Label>
						<ScopeSelector
							value={editedPaymentDetail.scope}
							scopeId={editedPaymentDetail.scopeId}
							scopeIds={(editedPaymentDetail as any).scopeIds}
							userPubkey={user?.pubkey || ''}
							onChange={(scope, scopeId, scopeName, scopeIds) => {
								setEditedPaymentDetail(
									(prev) =>
										({
											...prev,
											scope,
											scopeId,
											scopeName,
											scopeIds: scopeIds || [],
										}) as any,
								)
							}}
						/>
					</div>
				</div>

				<div className="space-y-2">
					<Label htmlFor="payment-details" className="font-medium">
						Goblin payment address
					</Label>
					<Input
						id="payment-details"
						data-testid="payment-details-input"
						value={editedPaymentDetail.paymentDetail}
						onChange={(e) => setEditedPaymentDetail((prev) => ({ ...prev, paymentDetail: e.target.value }))}
						placeholder="nprofile1... (from your Goblin wallet) or grin1..."
						className="w-full"
					/>
					<p className="text-xs text-muted-foreground">
						Buyers pay this address in Grin from their Goblin wallet. Share your Goblin nprofile (preferred, works over Nostr even while you
						are offline) or a Grin slatepack address.
					</p>
				</div>

				{validationMessage && formState === 'idle' && <p className="text-red-500 text-sm">{validationMessage}</p>}

				{formState !== 'idle' && (
					<div className="flex items-center gap-2">
						<Spinner />
						<span className="text-sm">Saving...</span>
					</div>
				)}

				<div className="space-y-4">
					<div className="flex items-center gap-2">
						<Checkbox
							id="default-payment"
							data-testid="default-payment-checkbox"
							checked={editedPaymentDetail.isDefault}
							onCheckedChange={(checked) => setEditedPaymentDetail((prev) => ({ ...prev, isDefault: !!checked }))}
						/>
						<Label htmlFor="default-payment" className="font-medium">
							Default
						</Label>
					</div>

					<div className="flex justify-between gap-2">
						<Button type="button" variant="ghost" size="icon" onClick={handlePasteFromClipboard} aria-label="Paste from clipboard">
							<ClipboardIcon className="w-5 h-5" />
						</Button>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={formState !== 'idle'}
								data-testid="cancel-payment-button"
							>
								Cancel
							</Button>

							{isEditing && (
								<Button
									type="button"
									variant="destructive"
									onClick={handleDelete}
									disabled={formState !== 'idle'}
									data-testid="delete-payment-button"
								>
									<TrashIcon className="w-4 h-4" />
								</Button>
							)}

							<Button type="submit" disabled={formState !== 'idle'} data-testid="save-payment-button">
								{formState === 'submitting' && <Spinner />}
								{formState === 'submitting' ? 'Saving...' : isEditing ? 'Update' : 'Save'}
							</Button>
						</div>
					</div>
				</div>
			</form>
		</div>
	)
}

interface PaymentDetailListItemProps {
	paymentDetail: RichPaymentDetail
	isOpen: boolean
	onOpenChange: (open: boolean) => void
	isDeleting?: boolean
	onSuccess?: () => void
}

function PaymentDetailListItem({ paymentDetail, isOpen, onOpenChange, isDeleting, onSuccess }: PaymentDetailListItemProps) {
	const deleteMutation = useDeletePaymentDetail()

	const handleDelete = () => {
		if (paymentDetail && paymentDetail.dTag) {
			deleteMutation.mutate(
				{ dTag: paymentDetail.dTag, userPubkey: paymentDetail.userId },
				{
					onSuccess: () => {
						toast.success('Payment detail deleted successfully')
						onOpenChange(false)
					},
					onError: (error) => {
						toast.error(`Error deleting payment detail: ${error.message}`)
					},
				},
			)
		}
	}

	const triggerContent = (
		<div>
			<p className="font-semibold">{paymentMethodLabels[paymentDetail.paymentMethod] || 'Goblin (GRIN)'}</p>
			<p className="text-sm text-muted-foreground break-all">
				{paymentDetail.paymentDetail} - {paymentDetail.scopeName}
			</p>
		</div>
	)

	const actions = (
		<div className="flex items-center gap-2">
			{paymentDetail.isDefault && <StarIcon className="w-5 h-5 text-yellow-400 fill-current" />}
			<Button
				variant="ghost"
				size="icon"
				onClick={(e) => {
					e.stopPropagation()
					handleDelete()
				}}
				className="h-8 w-8 text-destructive hover:bg-destructive/10"
				aria-label="Delete payment detail"
				disabled={deleteMutation.isPending}
			>
				{deleteMutation.isPending ? <Spinner className="h-4 w-4" /> : <TrashIcon className="h-4 w-4" />}
			</Button>
		</div>
	)

	return (
		<DashboardListItem
			isOpen={isOpen}
			onOpenChange={onOpenChange}
			triggerContent={triggerContent}
			actions={actions}
			isDeleting={deleteMutation.isPending}
			icon={<WalletIcon className="w-5 h-5 text-muted-foreground" />}
		>
			<PaymentDetailForm paymentDetail={paymentDetail} isOpen={isOpen} onOpenChange={onOpenChange} onSuccess={onSuccess} />
		</DashboardListItem>
	)
}

function ReceivingPaymentsComponent() {
	const { getUser } = useNDK()
	const [user, setUser] = useState<any>(null)
	const [openPaymentDetailId, setOpenPaymentDetailId] = useState<string | null>(null)
	useDashboardTitle('Receiving Payments')

	useEffect(() => {
		getUser().then(setUser)
	}, [getUser])

	const { data: paymentDetails, isLoading, isError, error } = useRichUserPaymentDetails(user?.pubkey)

	const handleOpenChange = (paymentDetailId: string | null, open: boolean) => {
		if (open) {
			setOpenPaymentDetailId(paymentDetailId)
		} else {
			setOpenPaymentDetailId(null)
		}
	}

	const handleSuccess = () => {
		setOpenPaymentDetailId(null)
	}

	if (isLoading) {
		return <div>Loading payment details...</div>
	}

	if (isError) {
		return <div>Error loading payment details: {error.message}</div>
	}

	const hasPaymentDetails = paymentDetails && paymentDetails.length > 0

	return (
		<div>
			<div className="hidden lg:flex sticky top-0 z-10 bg-white border-b py-4 px-4 lg:px-6 items-center justify-between">
				<h1 className="text-2xl font-bold">Receiving Payments</h1>
				{hasPaymentDetails && (
					<Button
						onClick={() => handleOpenChange('new', true)}
						className="bg-neutral-800 hover:bg-neutral-700 text-white flex items-center gap-2 px-4 py-2 text-sm font-semibold"
					>
						<PlusIcon className="w-5 h-5" />
						Add Payment Method
					</Button>
				)}
			</div>
			<div className="space-y-4 p-4 lg:p-6">
				{!hasPaymentDetails && openPaymentDetailId !== 'new' ? (
					<>
						<Card>
							<CardHeader>
								<CardTitle>Get paid in Grin with Goblin</CardTitle>
								<CardDescription>
									magick.market is GRIN-only. Buyers pay you directly from their Goblin wallet - no server, no middleman. To receive
									payments, add your Goblin payment address: open Goblin, copy your nprofile (Contacts &gt; your identity), and paste it
									here. Payments arrive over Nostr even if you are offline when the buyer pays; open Goblin to finalize them.
								</CardDescription>
							</CardHeader>
						</Card>
						<div className="flex justify-center pt-4">
							<Button
								onClick={() => handleOpenChange('new', true)}
								size="lg"
								className="bg-neutral-800 hover:bg-neutral-700 text-white flex items-center gap-2 px-6 py-3"
							>
								<PlusIcon className="w-5 h-5" />I Have a Goblin Wallet - Add Payment Address
							</Button>
						</div>
					</>
				) : (
					<>
						<div className="lg:hidden">
							<Button
								onClick={() => handleOpenChange('new', true)}
								className="w-full bg-neutral-800 hover:bg-neutral-700 text-white flex items-center justify-center gap-2 py-3 text-base font-semibold rounded-t-md rounded-b-none border-b border-neutral-600"
							>
								<PlusIcon className="w-5 h-5" />
								Add Payment Method
							</Button>
						</div>

						{/* Payment form - shows at top when opened */}
						{openPaymentDetailId === 'new' && (
							<Card className="mt-4">
								<CardHeader>
									<CardTitle>Add New Payment Detail</CardTitle>
									<CardDescription>Configure a new way to receive Grin payments</CardDescription>
								</CardHeader>
								<CardContent>
									<PaymentDetailForm
										paymentDetail={null}
										isOpen={openPaymentDetailId === 'new'}
										onOpenChange={(open) => handleOpenChange('new', open)}
										onSuccess={handleSuccess}
									/>
								</CardContent>
							</Card>
						)}

						<div className="space-y-4">
							{paymentDetails?.map((pd) => (
								<PaymentDetailListItem
									key={pd.id}
									paymentDetail={pd}
									isOpen={openPaymentDetailId === pd.id}
									onOpenChange={(open) => handleOpenChange(pd.id, open)}
									onSuccess={handleSuccess}
								/>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	)
}

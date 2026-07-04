export function Footer() {
	return (
		<footer className="sticky top-0 bg-black p-4 font-bold text-white lg:px-12 flex justify-center">
			<div className="container flex justify-between items-center flex-col gap-4 md:gap-0 md:flex-row">
				<div className="flex gap-4 flex-col md:flex-row items-center">
					<span>Plug into the Grin economy. Powered by Nostr.</span>
					<div className="flex gap-4">
						<a className="underline" href="/faqs">
							FAQ
						</a>
					</div>
				</div>
				<div className="text-right flex justify-between items-center gap-6">
					<a
						className="border-none hover:bg-secondary p-1 inline-flex justify-center items-center"
						href="https://njump.me/npub12tuz8sva4r832xh2axwt0myf33ygpnc9huvzhxe8y6jkvq2f3l2s9ye4k7"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/images/ostrich.svg" alt="Ostrich" className="h-6 w-6" />
					</a>
					<a
						className="border-none hover:bg-secondary p-1 inline-flex justify-center items-center"
						href="https://t.me/goblinfamily"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/images/telegram.svg" alt="Telegram" className="h-6 w-6" style={{ filter: 'invert(1)' }} />
					</a>
					<a
						className="border-none hover:bg-secondary p-1 inline-flex justify-center items-center"
						href="https://github.com/2ro/magick.market"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/images/github.svg" alt="GitHub" className="h-6 w-6" style={{ filter: 'invert(1)' }} />
					</a>
				</div>
			</div>
		</footer>
	)
}

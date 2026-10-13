'use client';

import { useOrderOpsSync } from '@/context/order-ops-sync';
import { isKotPrinterOnline } from '@/src/utils/print_servers';
import { maxOrderOpsVersion } from '@/src/models/order_ops';
import { LoadingSpinner } from '@/components/ui/touch-controls';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInFlightLock } from '@/src/utils/in_flight';

function offlineServicesBanner(
	hubOnline: boolean,
	kotPrinterOnline: boolean
): string | null {
	if (hubOnline && kotPrinterOnline) {
		return null;
	}
	if (!hubOnline && !kotPrinterOnline) {
		return 'Sync hub and KOT printer offline — auto KOT paused; print KOT manually';
	}
	if (!hubOnline) {
		return 'Sync hub offline — auto KOT paused; print KOT manually';
	}
	return 'KOT printer offline — auto KOT paused; print KOT manually';
}

/** Billing / checkout must stay tappable — never cover with sync catch-up modal. */
function isBillingPath(pathname: string | null): boolean {
	if (!pathname) {
		return false;
	}
	return (
		pathname === '/cart' ||
		pathname === '/bill' ||
		pathname === '/payment' ||
		pathname === '/freeflow' ||
		pathname.startsWith('/bill/') ||
		pathname.startsWith('/cart/')
	);
}

/** Soft banner + fullscreen catch-up / hub-offline notices. */
export function SyncWriteGateOverlay() {
	const pathname = usePathname();
	const billingFlow = isBillingPath(pathname);
	const {
		catchUpUi,
		syncHubOnline,
		connected,
		connectionState,
		writeGate,
		kotPrintFailure,
		memberDeviceNames,
		syncTransferProgress,
		syncFallbackPeers,
		connect,
		retryHubSync,
		continueWithLocalState,
		requestSyncFromDevice,
	} = useOrderOpsSync();
	const topBannerRef = useRef<HTMLDivElement>(null);
	const [browserOnline, setBrowserOnline] = useState(() =>
		typeof navigator === 'undefined' ? true : navigator.onLine
	);
	const [checkingStatus, setCheckingStatus] = useState(false);
	const [peerSyncTarget, setPeerSyncTarget] = useState<string | null>(null);
	const [peerSyncBusy, setPeerSyncBusy] = useState(false);
	const checkLock = useInFlightLock();

	const catchUpProgressLabel =
		syncTransferProgress && syncTransferProgress.total > 1
			? `Receiving sync… ${syncTransferProgress.received}/${syncTransferProgress.total}`
			: 'Updating… please wait';

	useEffect(() => {
		if (writeGate !== 'sync_failed') {
			setPeerSyncTarget(null);
		}
	}, [writeGate]);

	useEffect(() => {
		const updateOnline = () => setBrowserOnline(navigator.onLine);
		updateOnline();
		window.addEventListener('online', updateOnline);
		window.addEventListener('offline', updateOnline);
		return () => {
			window.removeEventListener('online', updateOnline);
			window.removeEventListener('offline', updateOnline);
		};
	}, []);

	// Only hard-block when the browser is offline or Ably has failed.
	// `connecting` / brief `idle` used to cover the whole UI for 10–15s on Android
	// while the socket came back — cart taps did nothing until then.
	const hardOffline =
		!browserOnline || connectionState === 'failed';
	const reconnecting =
		browserOnline &&
		!hardOffline &&
		(connectionState === 'connecting' ||
			(connectionState === 'idle' && !connected));
	const checking =
		checkingStatus || connectionState === 'connecting';

	const kotPrinterOnline = isKotPrinterOnline(memberDeviceNames);
	const offlineBanner =
		connected && writeGate === 'ready'
			? offlineServicesBanner(syncHubOnline, kotPrinterOnline)
			: null;
	const showCatchUpBanner = catchUpUi === 'banner' || (catchUpUi === 'fullscreen' && billingFlow);
	const showReconnectBanner = reconnecting && !showCatchUpBanner;
	const showTopBanner =
		showCatchUpBanner || showReconnectBanner || Boolean(offlineBanner);
	// Never fullscreen-block billing; allow soft banner only.
	const showCatchUpFullscreen =
		!billingFlow && !hardOffline && catchUpUi === 'fullscreen';

	useLayoutEffect(() => {
		const root = document.documentElement;
		const applyHeight = (height: number) => {
			root.style.setProperty('--ops-top-banner-height', `${Math.max(0, height)}px`);
		};

		if (!showTopBanner) {
			applyHeight(0);
			delete root.dataset.opsTopBanner;
			return;
		}

		root.dataset.opsTopBanner = 'true';

		const el = topBannerRef.current;
		if (!el) {
			applyHeight(0);
			delete root.dataset.opsTopBanner;
			return;
		}

		const update = () => applyHeight(el.getBoundingClientRect().height);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => {
			observer.disconnect();
			applyHeight(0);
			delete root.dataset.opsTopBanner;
		};
	}, [showTopBanner, showCatchUpBanner, showReconnectBanner, offlineBanner]);

	const handleCheckStatus = async () => {
		if (!checkLock.tryLock()) {
			return;
		}
		setCheckingStatus(true);
		setBrowserOnline(navigator.onLine);
		try {
			if (navigator.onLine && connectionState !== 'connected') {
				await connect();
			}
		} catch {
			// Connection error stays on the overlay until websocket is up.
		} finally {
			setCheckingStatus(false);
			checkLock.unlock();
		}
	};

	const topBanner = showCatchUpBanner ? (
		<div
			ref={topBannerRef}
			className="fixed top-0 inset-x-0 z-[60] bg-amber-500 text-amber-950 text-center text-sm font-semibold px-3 pb-2 shadow pt-[max(0.5rem,env(safe-area-inset-top,0px))]"
		>
			{catchUpProgressLabel}
		</div>
	) : showReconnectBanner ? (
		<div
			ref={topBannerRef}
			className="fixed top-0 inset-x-0 z-[60] bg-amber-500 text-amber-950 text-center text-sm font-semibold px-3 pb-2 shadow pt-[max(0.5rem,env(safe-area-inset-top,0px))]"
		>
			{connectionState === 'connecting'
				? 'Connecting sync…'
				: 'Reconnecting sync…'}
		</div>
	) : offlineBanner ? (
		<div
			ref={topBannerRef}
			className="fixed top-0 inset-x-0 z-[55] bg-orange-600 text-white text-center text-sm font-semibold px-3 pb-2 shadow pt-[max(0.5rem,env(safe-area-inset-top,0px))]"
		>
			{offlineBanner}
		</div>
	) : null;

	return (
		<>
			{topBanner}

			{showCatchUpFullscreen ? (
				<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-6">
					<div className="w-full max-w-sm rounded-2xl bg-white px-6 py-8 text-center shadow-xl">
						<div className="mx-auto mb-4 h-10 w-10 rounded-full border-4 border-gray-200 border-t-black animate-spin" />
						<p className="text-lg font-bold text-gray-900">
							{catchUpProgressLabel}
						</p>
						{syncTransferProgress && syncTransferProgress.total > 1 ? (
							<p className="mt-2 text-sm text-gray-500">
								Large sync — this may take a minute on slow networks.
							</p>
						) : (
							<p className="mt-2 text-sm text-gray-500">
								Catching up... please be patient.
							</p>
						)}
					</div>
				</div>
			) : null}

			{!hardOffline && writeGate === 'sync_failed' && !billingFlow ? (
				<div
					className="fixed inset-0 z-[75] flex items-center justify-center bg-black/55 px-6"
					role="alertdialog"
					aria-modal="true"
					aria-labelledby="ops-sync-failed-title"
				>
					<div className="w-full max-w-sm rounded-2xl bg-white px-6 py-8 shadow-xl max-h-[85vh] overflow-y-auto">
						{peerSyncTarget ? (
							<>
								<h2
									id="ops-sync-failed-title"
									className="text-lg font-bold text-gray-900"
								>
									Sync from another device
								</h2>
								<p className="mt-2 text-sm text-gray-600">
									Ask the staff on that device to stay online with the app open,
									then tap Continue.
								</p>
								<p className="mt-3 text-sm font-semibold text-gray-800">
									{syncFallbackPeers.find((p) => p.clientId === peerSyncTarget)
										?.deviceName ?? 'Selected device'}
								</p>
								<button
									type="button"
									disabled={peerSyncBusy}
									onClick={() => {
										setPeerSyncBusy(true);
										void requestSyncFromDevice(peerSyncTarget)
											.catch(() => undefined)
											.finally(() => setPeerSyncBusy(false));
									}}
									className="mt-6 w-full min-h-[48px] rounded-lg bg-black text-white text-sm font-bold disabled:opacity-60"
								>
									{peerSyncBusy ? (
										<LoadingSpinner className="mx-auto h-4 w-4 text-white" />
									) : (
										'Continue'
									)}
								</button>
								<button
									type="button"
									disabled={peerSyncBusy}
									onClick={() => setPeerSyncTarget(null)}
									className="mt-3 w-full min-h-[44px] rounded-lg bg-gray-100 text-gray-800 text-sm font-semibold"
								>
									Back
								</button>
							</>
						) : (
							<>
								<h2
									id="ops-sync-failed-title"
									className="text-lg font-bold text-gray-900"
								>
									Sync timed out
								</h2>
								<p className="mt-2 text-sm text-gray-600">
									Could not finish syncing from the hub. You can retry or copy
									from another online device.
								</p>
								<button
									type="button"
									onClick={() => void retryHubSync()}
									className="mt-6 w-full min-h-[48px] rounded-lg bg-black text-white text-sm font-bold"
								>
									Retry hub sync
								</button>
								{syncFallbackPeers.length > 0 ? (
									<div className="mt-4 space-y-2">
										<p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
											Online devices
										</p>
										{syncFallbackPeers.map((peer) => (
											<button
												key={peer.clientId}
												type="button"
												onClick={() => setPeerSyncTarget(peer.clientId)}
												className="w-full min-h-[44px] rounded-lg bg-gray-100 px-3 text-left text-sm font-semibold text-gray-800"
											>
												{peer.deviceName}
												<span className="block text-xs font-normal text-gray-500">
													v{maxOrderOpsVersion(peer.versions)}
												</span>
											</button>
										))}
									</div>
								) : (
									<p className="mt-4 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
										No other devices online right now.
									</p>
								)}
								<button
									type="button"
									onClick={continueWithLocalState}
									className="mt-4 w-full min-h-[44px] rounded-lg border border-gray-300 text-sm font-semibold text-gray-700"
								>
									Continue with this device&apos;s data
								</button>
							</>
						)}
					</div>
				</div>
			) : null}

			{hardOffline ? (
				<div
					className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-6"
					role="alertdialog"
					aria-modal="true"
					aria-labelledby="ops-offline-title"
				>
					<div className="w-full max-w-sm rounded-2xl bg-white px-6 py-8 text-center shadow-xl">
						<h2
							id="ops-offline-title"
							className="text-lg font-bold text-gray-900"
						>
							{!browserOnline
								? 'You are offline, get online to continue'
								: 'Sync connection failed'}
						</h2>
						<button
							type="button"
							onClick={() => void handleCheckStatus()}
							disabled={checking}
							className="mt-6 w-full min-h-[48px] inline-flex items-center justify-center rounded-lg bg-black text-white text-sm font-bold touch-manipulation active:bg-gray-800 disabled:opacity-60"
						>
							{checking ? (
								<LoadingSpinner className="h-4 w-4 text-white" />
							) : (
								'Check status'
							)}
						</button>
					</div>
				</div>
			) : null}

			{kotPrintFailure ? (
				<div className="fixed bottom-0 inset-x-0 z-[65] bg-red-600 text-white text-center text-sm font-semibold py-3 px-3 shadow pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
					{kotPrintFailure}
				</div>
			) : null}
		</>
	);
}

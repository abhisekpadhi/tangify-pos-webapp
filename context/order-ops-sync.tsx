'use client';

import {
	getOrderOpsChannel,
	maxOrderOpsVersion,
	OrderOpsPresenceData,
	OrderOpsSnapshot,
	SyncConflict,
	SyncConflictResolution,
	SyncRequestMessage,
} from '@/src/models/order_ops';
import {
	getDeviceDisplayName,
	getOrderOpsMeta,
	getStableDeviceId,
	setDeviceDisplayName,
} from '@/src/utils/order_ops_meta';
import {
	applyLoyaltyWaLink,
	type LoyaltyWaLinkMessage,
} from '@/src/utils/loyalty_wa_link';
import {
	detectSyncConflict,
	handleStateDelta,
	handleSyncRequest,
	handleSyncResponse,
	maybeRequestSyncFromPeers,
	registerOrderOpsPresenceUpdater,
	registerOrderOpsPublisher,
	registerKotPrintPublisher,
	registerBillPrintPublisher,
	requestSyncFromPeer,
	resetSyncRequestCooldown,
	resolveSyncKeepLocal,
	setSyncConflictBlocking,
	unregisterOrderOpsPresenceUpdater,
	unregisterOrderOpsPublisher,
	unregisterKotPrintPublisher,
	unregisterBillPrintPublisher,
	getPeerDeviceName,
	isSyncHubOnlineAmong,
	applyKotPrintedAck,
	listFallbackSyncPeers,
	SYNC_CHUNK_TIMEOUT_MS,
	type PresenceMember,
	type KotPrintAckMessage,
	type PickSyncSourceOptions,
	type SyncTransferProgress,
} from '@/src/utils/order_ops_sync';
import {
	publishStateDeltaChunks,
	StateDeltaChunkAssembler,
	SyncResponseChunkAssembler,
	type StateDeltaWireMessage,
	type SyncResponseWireMessage,
} from '@/src/utils/sync_response_chunk';
import type { SyncConflictPeer } from '@/src/models/order_ops';
import {
	getWriteGateState,
	setWriteGateState,
	subscribeWriteGate,
	getPreferFullscreenCatchUp,
	getCatchUpStartedAt,
	type WriteGateState,
} from '@/src/utils/sync_write_gate';
import {
	handleTableCloseIntent,
	registerTableClosePublisher,
	unregisterTableClosePublisher,
} from '@/src/utils/order_close_intent';
import { getTodayDateKey } from '@/src/utils/inventory_utils';
import Ably, { PresenceMessage, Realtime, RealtimeChannel } from 'ably';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react';

export type OrderOpsConnectionState =
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'failed';

export type CatchUpUiMode = 'none' | 'banner' | 'fullscreen';

type OrderOpsSyncContextValue = {
	connected: boolean;
	connectionState: OrderOpsConnectionState;
	syncing: boolean;
	memberCount: number;
	/** Presence device names currently on the channel (including this device). */
	memberDeviceNames: string[];
	deviceId: string;
	deviceName: string;
	channelName: string;
	stateVersion: number | null;
	businessDate: string | null;
	error: string | null;
	syncConflict: SyncConflict | null;
	writeGate: WriteGateState;
	canWrite: boolean;
	catchUpUi: CatchUpUiMode;
	syncHubOnline: boolean;
	/** Chunk progress while receiving a sync transfer. */
	syncTransferProgress: SyncTransferProgress | null;
	/** Peers available when hub sync fails. */
	syncFallbackPeers: SyncConflictPeer[];
	/** Short-lived KOT print failure message (auto-clears). */
	kotPrintFailure: string | null;
	connect: () => Promise<void>;
	updateDeviceName: (name: string) => Promise<void>;
	resolveSyncConflict: (
		resolution: SyncConflictResolution,
		peerClientId?: string
	) => Promise<void>;
	retryHubSync: () => Promise<void>;
	continueWithLocalState: () => void;
	requestSyncFromDevice: (peerClientId: string) => Promise<void>;
};

const OrderOpsSyncContext = createContext<OrderOpsSyncContextValue>({
	connected: false,
	connectionState: 'idle',
	syncing: false,
	memberCount: 0,
	memberDeviceNames: [],
	deviceId: '',
	deviceName: '',
	channelName: getOrderOpsChannel(),
	stateVersion: null,
	businessDate: null,
	error: null,
	syncConflict: null,
	writeGate: 'offline',
	canWrite: false,
	catchUpUi: 'none',
	syncHubOnline: false,
	syncTransferProgress: null,
	syncFallbackPeers: [],
	kotPrintFailure: null,
	connect: async () => undefined,
	updateDeviceName: async () => undefined,
	resolveSyncConflict: async () => undefined,
	retryHubSync: async () => undefined,
	continueWithLocalState: () => undefined,
	requestSyncFromDevice: async () => undefined,
});

export function useOrderOpsSync() {
	return useContext(OrderOpsSyncContext);
}

function mapPresenceMembers(members: PresenceMessage[]): PresenceMember[] {
	return members.map((member) => ({
		clientId: member.clientId,
		timestamp: member.timestamp ?? 0,
		data: member.data as Record<string, unknown> | undefined,
	}));
}

async function requestSyncFromPeers(
	channel: RealtimeChannel,
	members: PresenceMember[],
	selfClientId: string,
	options?: PickSyncSourceOptions
) {
	return maybeRequestSyncFromPeers(
		async (payload) => {
			await channel.publish('sync:request', payload);
		},
		members,
		selfClientId,
		options
	);
}

async function updateChannelPresence(channel: RealtimeChannel) {
	const meta = await getOrderOpsMeta();
	const data: OrderOpsPresenceData = {
		deviceId: meta.deviceId,
		deviceName: getDeviceDisplayName(),
		versions: meta.versions,
		stateVersion: maxOrderOpsVersion(meta.versions),
		businessDate: meta.businessDate,
		initializedForToday: meta.initializedForToday ?? false,
		isSyncHub: false,
	};

	try {
		await channel.presence.update(data);
	} catch {
		await channel.presence.enter(data);
	}
}

async function publishSyncRequest(
	channel: RealtimeChannel,
	payload: SyncRequestMessage
) {
	await channel.publish('sync:request', payload);
}

type ConnectionHandlers = {
	onConnecting: () => void;
	onConnected: () => void;
	onDisconnected: () => void;
	onFailed: (stateChange: Ably.ConnectionStateChange) => void;
};

function isAblyConnectionAlive(realtime: Realtime | null): boolean {
	if (!realtime) {
		return false;
	}
	const state = realtime.connection.state;
	return state !== 'closed' && state !== 'closing' && state !== 'failed';
}

async function teardownAbly(
	realtime: Realtime | null,
	channel: RealtimeChannel | null,
	handlers: ConnectionHandlers | null
): Promise<void> {
	// Strict Mode / route remounts tear down while Ably is mid-flight.
	// Never let leave/detach/close rejections bubble to Next's overlay.
	try {
		if (realtime && handlers) {
			try {
				realtime.connection.off('connecting', handlers.onConnecting);
				realtime.connection.off('connected', handlers.onConnected);
				realtime.connection.off('disconnected', handlers.onDisconnected);
				realtime.connection.off('failed', handlers.onFailed);
			} catch {
				// Ignore handler cleanup races.
			}
		}

		if (channel) {
			try {
				channel.presence.unsubscribe();
			} catch {
				// Presence may not be subscribed yet during hot reload / Strict Mode.
			}

			try {
				channel.unsubscribe();
			} catch {
				// Channel may already be detached during hot reload / Strict Mode.
			}

			const canLeaveOrDetach =
				isAblyConnectionAlive(realtime) &&
				(channel.state === 'attached' ||
					channel.state === 'attaching' ||
					channel.state === 'suspended');

			if (canLeaveOrDetach) {
				// Fire-and-forget: awaiting leave/detach often rejects with
				// "Connection closed" once close() starts (esp. on Android / Strict Mode).
				void Promise.resolve(channel.presence.leave()).catch(() => {});
				void Promise.resolve(channel.detach()).catch(() => {});
			}
		}

		if (!isAblyConnectionAlive(realtime) || !realtime) {
			return;
		}

		try {
			realtime.close();
		} catch {
			// Ably can throw if the connection is already closed.
		}
	} catch (error) {
		console.warn('[ably] teardown ignored:', error);
	}
}

export function OrderOpsSyncProvider({ children }: { children: ReactNode }) {
	const [connectionState, setConnectionState] =
		useState<OrderOpsConnectionState>('idle');
	const [syncing, setSyncing] = useState(false);
	const [memberCount, setMemberCount] = useState(0);
	const [memberDeviceNames, setMemberDeviceNames] = useState<string[]>([]);
	const [stateVersion, setStateVersion] = useState<number | null>(null);
	const [businessDate, setBusinessDate] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [deviceId, setDeviceId] = useState('');
	const [deviceName, setDeviceName] = useState('');
	const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
	const [writeGate, setWriteGate] = useState<WriteGateState>(() =>
		getWriteGateState()
	);
	const [syncHubOnline, setSyncHubOnline] = useState(false);
	const [syncTransferProgress, setSyncTransferProgress] =
		useState<SyncTransferProgress | null>(null);
	const [syncFallbackPeers, setSyncFallbackPeers] = useState<
		SyncConflictPeer[]
	>([]);
	const [kotPrintFailure, setKotPrintFailure] = useState<string | null>(null);
	const [catchUpUi, setCatchUpUi] = useState<CatchUpUiMode>('none');

	const realtimeRef = useRef<Realtime | null>(null);
	const channelRef = useRef<RealtimeChannel | null>(null);
	const connectionHandlersRef = useRef<ConnectionHandlers | null>(null);
	const selfDeviceIdRef = useRef('');
	const cancelledRef = useRef(false);
	const connectPromiseRef = useRef<Promise<void> | null>(null);
	const connectionStateRef = useRef<OrderOpsConnectionState>('idle');
	const syncActivityCountRef = useRef(0);
	const conflictResolvedRef = useRef(false);
	const pendingSyncRequestRef = useRef(false);
	const everConnectedRef = useRef(false);
	const syncHubOnlineRef = useRef(false);
	const syncTransferTimerRef = useRef<number | null>(null);
	const syncChunkAssemblerRef = useRef(new SyncResponseChunkAssembler());
	const stateDeltaChunkAssemblerRef = useRef(new StateDeltaChunkAssembler());
	const setupRealtimeRef = useRef<(selfDeviceId: string) => void>(() => {});
	const connectRef = useRef<() => Promise<void> | void>(() => {});
	const refreshMemberCountRef = useRef<
		(
			channel: RealtimeChannel,
			selfClientId: string,
			options?: { checkConflict?: boolean; fullscreenCatchUp?: boolean }
		) => Promise<void>
	>(async () => {});

	useEffect(() => {
		return subscribeWriteGate(() => {
			setWriteGate(getWriteGateState());
		});
	}, []);

	useEffect(() => {
		if (!kotPrintFailure) {
			return;
		}
		const timer = window.setTimeout(() => setKotPrintFailure(null), 8000);
		return () => window.clearTimeout(timer);
	}, [kotPrintFailure]);

	useEffect(() => {
		if (writeGate !== 'catching_up') {
			setCatchUpUi('none');
			return;
		}
		const FULLSCREEN_AFTER_MS = 1500;
		const tick = () => {
			const preferFullscreen =
				getPreferFullscreenCatchUp() ||
				Date.now() - getCatchUpStartedAt() >= FULLSCREEN_AFTER_MS;
			setCatchUpUi(preferFullscreen ? 'fullscreen' : 'banner');
		};
		tick();
		const id = window.setInterval(tick, 400);
		return () => window.clearInterval(id);
	}, [writeGate]);

	const runWithSyncIndicator = useCallback(
		async (operation: () => Promise<void>) => {
			syncActivityCountRef.current += 1;
			setSyncing(true);
			try {
				await operation();
			} finally {
				syncActivityCountRef.current -= 1;
				if (syncActivityCountRef.current <= 0) {
					syncActivityCountRef.current = 0;
					setSyncing(false);
				}
			}
		},
		[]
	);

	const refreshMeta = useCallback(async () => {
		const meta = await getOrderOpsMeta();
		setStateVersion(maxOrderOpsVersion(meta.versions));
		setBusinessDate(meta.businessDate);
	}, []);

	const clearSyncTransferTimer = useCallback(() => {
		if (syncTransferTimerRef.current != null) {
			window.clearTimeout(syncTransferTimerRef.current);
			syncTransferTimerRef.current = null;
		}
	}, []);

	const resetSyncTransfer = useCallback(() => {
		clearSyncTransferTimer();
		syncChunkAssemblerRef.current.abort();
		setSyncTransferProgress(null);
	}, [clearSyncTransferTimer]);

	const finishCatchUpReady = useCallback(() => {
		pendingSyncRequestRef.current = false;
		resetSyncTransfer();
		if (
			getWriteGateState() === 'catching_up' ||
			getWriteGateState() === 'sync_failed'
		) {
			setWriteGateState('ready');
		}
		setSyncFallbackPeers([]);
	}, [resetSyncTransfer]);

	const failSyncTransfer = useCallback(
		async (channel: RealtimeChannel, selfClientId: string) => {
			if (cancelledRef.current) {
				return;
			}
			resetSyncTransfer();
			pendingSyncRequestRef.current = false;
			try {
				const members = mapPresenceMembers(await channel.presence.get());
				const today = getTodayDateKey();
				setSyncFallbackPeers(
					listFallbackSyncPeers(members, selfClientId, today)
				);
			} catch {
				setSyncFallbackPeers([]);
			}
			setWriteGateState('sync_failed');
			console.warn('[sync-gate] sync transfer timed out');
		},
		[resetSyncTransfer]
	);

	const scheduleSyncTransferTimer = useCallback(
		(channel: RealtimeChannel, selfClientId: string) => {
			clearSyncTransferTimer();
			syncTransferTimerRef.current = window.setTimeout(() => {
				void failSyncTransfer(channel, selfClientId);
			}, SYNC_CHUNK_TIMEOUT_MS);
		},
		[clearSyncTransferTimer, failSyncTransfer]
	);

	const beginSyncTransfer = useCallback(
		(channel: RealtimeChannel, selfClientId: string) => {
			resetSyncTransfer();
			pendingSyncRequestRef.current = true;
			scheduleSyncTransferTimer(channel, selfClientId);
		},
		[resetSyncTransfer, scheduleSyncTransferTimer]
	);

	const onSyncChunkProgress = useCallback(
		(
			channel: RealtimeChannel,
			selfClientId: string,
			progress: SyncTransferProgress
		) => {
			setSyncTransferProgress(progress);
			if (progress.received >= progress.total) {
				clearSyncTransferTimer();
				return;
			}
			scheduleSyncTransferTimer(channel, selfClientId);
		},
		[clearSyncTransferTimer, scheduleSyncTransferTimer]
	);

	const refreshMemberCount = useCallback(
		async (
			channel: RealtimeChannel,
			selfClientId: string,
			options?: { checkConflict?: boolean; fullscreenCatchUp?: boolean }
		) => {
			const checkConflict = options?.checkConflict ?? false;
			const hasActiveTransfer = pendingSyncRequestRef.current;

			try {
				const members = await channel.presence.get();
				if (cancelledRef.current) {
					return;
				}
				const mapped = mapPresenceMembers(members);
				const today = getTodayDateKey();
				setMemberCount(mapped.length);
				setMemberDeviceNames(
					mapped.map((member) => getPeerDeviceName(member))
				);
				const hubOnline = isSyncHubOnlineAmong(
					mapped,
					selfClientId,
					today
				);
				const hubJustCameOnline =
					hubOnline && !syncHubOnlineRef.current;
				syncHubOnlineRef.current = hubOnline;
				setSyncHubOnline(hubOnline);

				if (hubOnline === false && hasActiveTransfer) {
					resetSyncTransfer();
					pendingSyncRequestRef.current = false;
					setSyncFallbackPeers(
						listFallbackSyncPeers(mapped, selfClientId, today)
					);
					setWriteGateState('sync_failed');
					return;
				}

				if (checkConflict) {
					const conflict = await detectSyncConflict(mapped, selfClientId);
					if (conflict && !conflictResolvedRef.current) {
						setSyncConflictBlocking(true);
						setSyncConflict(conflict);
						setWriteGateState('awaiting_choice');
						return;
					}

					setSyncConflict(null);
					setSyncConflictBlocking(false);
				}

				if (hasActiveTransfer || getWriteGateState() === 'sync_failed') {
					return;
				}

				const shouldFullscreen =
					options?.fullscreenCatchUp === true || hubJustCameOnline;

				const applySyncResult = async (result: {
					requested: boolean;
					reason: string;
				}) => {
					if (cancelledRef.current) {
						return;
					}
					if (result.requested) {
						setWriteGateState('catching_up', {
							fullscreen: shouldFullscreen,
						});
						beginSyncTransfer(channel, selfClientId);
						return;
					}
					if (result.reason === 'hub_not_ready') {
						setWriteGateState('catching_up', {
							fullscreen: shouldFullscreen,
						});
						clearSyncTransferTimer();
						syncTransferTimerRef.current = window.setTimeout(() => {
							if (cancelledRef.current) {
								return;
							}
							void refreshMemberCount(channel, selfClientId, options);
						}, SYNC_CHUNK_TIMEOUT_MS);
						return;
					}
					if (result.reason === 'cooldown') {
						setWriteGateState('catching_up', {
							fullscreen: shouldFullscreen,
						});
						clearSyncTransferTimer();
						syncTransferTimerRef.current = window.setTimeout(() => {
							if (cancelledRef.current) {
								return;
							}
							void refreshMemberCount(channel, selfClientId, options);
						}, SYNC_CHUNK_TIMEOUT_MS);
						return;
					}
					pendingSyncRequestRef.current = false;
					resetSyncTransfer();
					setWriteGateState('ready');
				};

				await runWithSyncIndicator(async () => {
					const result = await requestSyncFromPeers(
						channel,
						mapped,
						selfClientId,
						{ p2pFallback: false }
					);
					await applySyncResult(result);
				});
			} catch (presenceError) {
				console.error('Failed to read order_ops presence:', presenceError);
			}
		},
		[
			runWithSyncIndicator,
			beginSyncTransfer,
			clearSyncTransferTimer,
			resetSyncTransfer,
		]
	);

	const setupRealtime = useCallback(
		(selfDeviceId: string) => {
			if (realtimeRef.current) {
				return;
			}

			cancelledRef.current = false;

			const realtime = new Ably.Realtime({
				clientId: selfDeviceId,
				authCallback: (_tokenParams, callback) => {
					fetch(
						`/api/ably/token?deviceId=${encodeURIComponent(selfDeviceId)}`
					)
						.then(async (response) => {
							if (!response.ok) {
								const body = await response.text();
								callback(body || 'Token request failed', null);
								return;
							}
							const token = await response.json();
							callback(null, token);
						})
						.catch((authError: Error) => {
							callback(authError.message, null);
						});
				},
			});

			realtimeRef.current = realtime;
			const channel = realtime.channels.get(getOrderOpsChannel());
			channelRef.current = channel;

			const enterPresence = async () => {
				if (cancelledRef.current) {
					return;
				}

				try {
					const meta = await getOrderOpsMeta();
					if (cancelledRef.current) {
						return;
					}

					const data: OrderOpsPresenceData = {
						deviceId: meta.deviceId,
						deviceName: getDeviceDisplayName(),
						versions: meta.versions,
						stateVersion: maxOrderOpsVersion(meta.versions),
						businessDate: meta.businessDate,
						initializedForToday: meta.initializedForToday ?? false,
						isSyncHub: false,
					};

					if (channel.state !== 'attached' && channel.state !== 'attaching') {
						await channel.attach();
					}

					if (cancelledRef.current) {
						return;
					}

					await channel.presence.enter(data);
					await refreshMeta();
					await refreshMemberCountRef.current(channel, selfDeviceId, {
						checkConflict: true,
					});
				} catch (presenceError) {
					if (!cancelledRef.current) {
						console.error('Failed to enter order_ops presence:', presenceError);
					}
				}
			};

			const onConnected = () => {
				if (cancelledRef.current) {
					return;
				}
				resetSyncRequestCooldown();
				const fullscreen = everConnectedRef.current;
				everConnectedRef.current = true;
				setWriteGateState('catching_up', { fullscreen });
				setConnectionState('connected');
				setError(null);
				void enterPresence();
			};

			const onConnecting = () => {
				if (cancelledRef.current) {
					return;
				}
				setConnectionState('connecting');
			};

			const onDisconnected = () => {
				if (cancelledRef.current) {
					return;
				}
				setConnectionState('idle');
				setMemberCount(0);
				setMemberDeviceNames([]);
				setSyncHubOnline(false);
				syncHubOnlineRef.current = false;
				setSyncConflict(null);
				setSyncConflictBlocking(false);
				conflictResolvedRef.current = false;
				pendingSyncRequestRef.current = false;
				resetSyncTransfer();
				setWriteGateState('offline');
				resetSyncRequestCooldown();
			};

			const onFailed = (stateChange: Ably.ConnectionStateChange) => {
				if (cancelledRef.current) {
					return;
				}
				setConnectionState('failed');
				setMemberCount(0);
				setMemberDeviceNames([]);
				setSyncHubOnline(false);
				syncHubOnlineRef.current = false;
				setSyncConflict(null);
				setSyncConflictBlocking(false);
				conflictResolvedRef.current = false;
				pendingSyncRequestRef.current = false;
				resetSyncTransfer();
				setWriteGateState('offline');
				resetSyncRequestCooldown();
				setError(stateChange.reason?.message ?? 'Connection failed');
			};

			realtime.connection.on('connecting', onConnecting);
			realtime.connection.on('connected', onConnected);
			realtime.connection.on('disconnected', onDisconnected);
			realtime.connection.on('failed', onFailed);
			connectionHandlersRef.current = {
				onConnecting,
				onConnected,
				onDisconnected,
				onFailed,
			};

			channel.subscribe('sync:request', async (message) => {
				const payload = message.data as SyncRequestMessage;
				await runWithSyncIndicator(async () => {
					await handleSyncRequest(
						payload,
						async (response: SyncResponseWireMessage) => {
							await channel.publish('sync:response', response);
						}
					);
				});
			});

			channel.subscribe('sync:response', async (message) => {
				await runWithSyncIndicator(async () => {
					const wire = message.data as SyncResponseWireMessage;
					const { applied, progress, completeForSelf } =
						await handleSyncResponse(wire, syncChunkAssemblerRef.current);
					if (progress) {
						onSyncChunkProgress(channel, selfDeviceId, progress);
					}
					// Empty / already-current SoT still clears the transfer timer via
					// progress; finish catch-up even when nothing was applied.
					if (!applied && !completeForSelf) {
						return;
					}
					await refreshMeta();
					await updateChannelPresence(channel);
					finishCatchUpReady();
				});
			});

			channel.subscribe('state:delta', async (message) => {
				await runWithSyncIndicator(async () => {
					const complete = stateDeltaChunkAssemblerRef.current.ingest(
						message.data as StateDeltaWireMessage
					);
					if (!complete) {
						return;
					}
					await handleStateDelta(complete);
					await refreshMeta();
				});
			});

			channel.subscribe('orders:close', async (message) => {
				await runWithSyncIndicator(async () => {
					await handleTableCloseIntent(
						message.data as import('@/src/utils/order_close_intent').TableCloseIntent,
					);
					await refreshMeta();
				});
			});

			channel.subscribe('kot:printed', async (message) => {
				const payload = message.data as KotPrintAckMessage;
				const orderId = payload?.orderId?.trim();
				if (!orderId) return;
				try {
					await applyKotPrintedAck(orderId, payload.printedAt ?? Date.now());
				} catch (err) {
					console.warn('[kot-ack] apply printed failed', err);
				}
			});

			channel.subscribe('kot:failed', (message) => {
				const payload = message.data as KotPrintAckMessage;
				const orderId = payload?.orderId?.trim() || 'order';
				const detail = payload?.error?.trim();
				setKotPrintFailure(
					detail
						? `KOT print failed (${orderId}): ${detail}`
						: `KOT print failed for ${orderId}`
				);
			});

			channel.subscribe('loyalty:wa-link', async (message) => {
				try {
					await applyLoyaltyWaLink(message.data as LoyaltyWaLinkMessage);
				} catch (err) {
					console.warn('[loyalty-wa-link] apply failed', err);
				}
			});

			channel.presence.subscribe('enter', () => {
				void refreshMemberCountRef.current(channel, selfDeviceId, {
					checkConflict: true,
				});
			});
			channel.presence.subscribe(['leave', 'update'], () => {
				void refreshMemberCountRef.current(channel, selfDeviceId);
			});

			registerOrderOpsPublisher(async (snapshot: OrderOpsSnapshot) => {
				const activeChannel = channelRef.current;
				if (!activeChannel) {
					return;
				}

				await updateChannelPresence(activeChannel);

				const members = mapPresenceMembers(
					await activeChannel.presence.get()
				);
				if (members.length <= 1) {
					return;
				}

				await runWithSyncIndicator(async () => {
					await publishStateDeltaChunks(async (payload) => {
						await activeChannel.publish('state:delta', payload);
					}, snapshot);
				});
			});

			registerKotPrintPublisher(async (payload) => {
				const activeChannel = channelRef.current;
				if (!activeChannel) {
					throw new Error('Sync channel is not ready');
				}
				await activeChannel.publish('kot:print', payload);
			});

			registerBillPrintPublisher(async (payload) => {
				const activeChannel = channelRef.current;
				if (!activeChannel) {
					throw new Error('Sync channel is not ready');
				}
				await activeChannel.publish('bill:print', payload);
			});

			registerTableClosePublisher(async (intent) => {
				const activeChannel = channelRef.current;
				if (!activeChannel) {
					throw new Error('Sync channel is not ready');
				}
				await activeChannel.publish('orders:close', intent);
			});

			registerOrderOpsPresenceUpdater(async () => {
				const activeChannel = channelRef.current;
				if (!activeChannel || cancelledRef.current) {
					return;
				}

				await updateChannelPresence(activeChannel);
			});
		},
		[refreshMemberCount, refreshMeta, runWithSyncIndicator, resetSyncTransfer, finishCatchUpReady, onSyncChunkProgress]
	);

	const connect = useCallback(async () => {
		if (typeof window === 'undefined') {
			return;
		}

		if (connectionStateRef.current === 'connected') {
			return;
		}

		if (connectPromiseRef.current) {
			return connectPromiseRef.current;
		}

		const selfDeviceId = getStableDeviceId();
		setDeviceId(selfDeviceId);
		setError(null);
		setConnectionState('connecting');

		setupRealtime(selfDeviceId);

		const realtime = realtimeRef.current;
		if (!realtime) {
			setConnectionState('failed');
			setError('Failed to initialize sync client');
			return;
		}

		const promise = new Promise<void>((resolve, reject) => {
			const onSuccess = () => {
				cleanupListeners();
				resolve();
			};
			const onFailure = (stateChange: Ably.ConnectionStateChange) => {
				cleanupListeners();
				if (cancelledRef.current) {
					resolve();
					return;
				}
				reject(
					new Error(stateChange.reason?.message ?? 'Connection failed')
				);
			};
			const onClosedDuringConnect = () => {
				cleanupListeners();
				// Teardown/Strict Mode closed the socket mid-connect — not a hard fail.
				resolve();
			};

			const cleanupListeners = () => {
				realtime.connection.off('connected', onSuccess);
				realtime.connection.off('failed', onFailure);
				realtime.connection.off('closed', onClosedDuringConnect);
			};

			realtime.connection.once('connected', onSuccess);
			realtime.connection.once('failed', onFailure);
			realtime.connection.once('closed', onClosedDuringConnect);

			if (realtime.connection.state === 'connected') {
				onSuccess();
				return;
			}

			if (
				realtime.connection.state === 'closed' ||
				realtime.connection.state === 'closing' ||
				cancelledRef.current
			) {
				cleanupListeners();
				resolve();
				return;
			}

			realtime.connect();
		})
			.catch((connectError: Error) => {
				if (cancelledRef.current) {
					return;
				}
				setConnectionState('failed');
				setError(connectError.message);
				// Do not rethrow — callers use `void connect()` and a rethrow
				// becomes an unhandled rejection (e.g. "Connection closed" on teardown).
			})
			.finally(() => {
				connectPromiseRef.current = null;
			});

		connectPromiseRef.current = promise;
		return promise;
	}, [setupRealtime]);

	const updateDeviceName = useCallback(async (name: string) => {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new Error('Device name is required');
		}
		setDeviceDisplayName(trimmed);
		setDeviceName(getDeviceDisplayName());

		const channel = channelRef.current;
		if (channel && connectionStateRef.current === 'connected') {
			await updateChannelPresence(channel);
		}
	}, []);

	const retryHubSync = useCallback(async () => {
		const channel = channelRef.current;
		const selfClientId = selfDeviceIdRef.current;
		if (!channel || !selfClientId) {
			return;
		}
		resetSyncRequestCooldown();
		setSyncFallbackPeers([]);
		setWriteGateState('catching_up', { fullscreen: true });
		await refreshMemberCount(channel, selfClientId, {
			checkConflict: true,
			fullscreenCatchUp: true,
		});
	}, [refreshMemberCount]);

	const continueWithLocalState = useCallback(() => {
		finishCatchUpReady();
	}, [finishCatchUpReady]);

	const requestSyncFromDevice = useCallback(
		async (peerClientId: string) => {
			const channel = channelRef.current;
			const selfClientId = selfDeviceIdRef.current;
			if (!channel || !selfClientId || !peerClientId) {
				return;
			}
			setSyncFallbackPeers([]);
			setWriteGateState('catching_up', { fullscreen: true });
			resetSyncRequestCooldown();
			beginSyncTransfer(channel, selfClientId);
			await runWithSyncIndicator(async () => {
				await requestSyncFromPeer(
					async (payload) => publishSyncRequest(channel, payload),
					selfClientId,
					peerClientId
				);
			});
		},
		[beginSyncTransfer, runWithSyncIndicator]
	);

	const resolveSyncConflict = useCallback(
		async (resolution: SyncConflictResolution, peerClientId?: string) => {
			const channel = channelRef.current;
			const selfClientId = selfDeviceIdRef.current;
			if (!channel || !selfClientId) {
				return;
			}

			conflictResolvedRef.current = true;
			setSyncConflictBlocking(false);
			setSyncConflict(null);
			setWriteGateState('catching_up');

			await runWithSyncIndicator(async () => {
				const publish = async (payload: SyncRequestMessage) =>
					publishSyncRequest(channel, payload);

				if (resolution === 'newest') {
					const members = mapPresenceMembers(await channel.presence.get());
					const result = await maybeRequestSyncFromPeers(
						publish,
						members,
						selfClientId,
						{ p2pFallback: true }
					);
					if (!result.requested) {
						setWriteGateState('ready');
					} else {
						beginSyncTransfer(channel, selfClientId);
					}
				} else if (resolution === 'peer' && peerClientId) {
					await requestSyncFromPeer(publish, selfClientId, peerClientId);
					beginSyncTransfer(channel, selfClientId);
				} else if (resolution === 'local') {
					await resolveSyncKeepLocal();
					setWriteGateState('ready');
				}
			});

			await refreshMeta();
			await updateChannelPresence(channel);
		},
		[refreshMeta, runWithSyncIndicator, beginSyncTransfer]
	);

	setupRealtimeRef.current = setupRealtime;
	connectRef.current = connect;
	refreshMemberCountRef.current = refreshMemberCount;

	useEffect(() => {
		if (typeof window === 'undefined') {
			return;
		}

		cancelledRef.current = false;
		const selfDeviceId = getStableDeviceId();
		selfDeviceIdRef.current = selfDeviceId;
		setDeviceId(selfDeviceId);
		setDeviceName(getDeviceDisplayName());
		setupRealtimeRef.current(selfDeviceId);
		void connectRef.current();

		const attemptSyncFromPeers = () => {
			const channel = channelRef.current;
			const selfClientId = selfDeviceIdRef.current;
			if (!channel || !selfClientId || cancelledRef.current) {
				return;
			}

			resetSyncRequestCooldown();
			void refreshMemberCountRef
				.current(channel, selfClientId, {
					checkConflict: true,
					fullscreenCatchUp: true,
				})
				.catch((presenceError) => {
					console.error('Failed to refresh sync on focus:', presenceError);
				});
		};

		const onWindowFocus = () => {
			attemptSyncFromPeers();
		};

		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				attemptSyncFromPeers();
			}
		};

		window.addEventListener('focus', onWindowFocus);
		document.addEventListener('visibilitychange', onVisibilityChange);

		return () => {
			cancelledRef.current = true;
			window.removeEventListener('focus', onWindowFocus);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			if (syncTransferTimerRef.current != null) {
				window.clearTimeout(syncTransferTimerRef.current);
				syncTransferTimerRef.current = null;
			}
			syncChunkAssemblerRef.current.abort();
			unregisterOrderOpsPublisher();
			unregisterKotPrintPublisher();
			unregisterBillPrintPublisher();
			unregisterTableClosePublisher();
			unregisterOrderOpsPresenceUpdater();
			void teardownAbly(
				realtimeRef.current,
				channelRef.current,
				connectionHandlersRef.current
			).catch(() => {});
			realtimeRef.current = null;
			channelRef.current = null;
			connectionHandlersRef.current = null;
			connectPromiseRef.current = null;
		};
		// Keep a single Ably realtime for the provider lifetime. Recreating it on
		// callback identity changes freezes Android carts for ~10–15s behind overlays.
	}, []);

	const connected = connectionState === 'connected';

	connectionStateRef.current = connectionState;

	return (
		<OrderOpsSyncContext.Provider
			value={{
				connected,
				connectionState,
				syncing,
				memberCount,
				memberDeviceNames,
				deviceId,
				deviceName,
				channelName: getOrderOpsChannel(),
				stateVersion,
				businessDate,
				error,
				syncConflict,
				writeGate,
				canWrite: writeGate === 'ready',
				catchUpUi,
				syncHubOnline,
				syncTransferProgress,
				syncFallbackPeers,
				kotPrintFailure,
				connect,
				updateDeviceName,
				resolveSyncConflict,
				retryHubSync,
				continueWithLocalState,
				requestSyncFromDevice,
			}}
		>
			{children}
		</OrderOpsSyncContext.Provider>
	);
}

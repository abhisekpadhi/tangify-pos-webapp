import {
	ORDER_OPS_DEVICE_ID_KEY,
	ORDER_OPS_DEVICE_NAME_KEY,
	ORDER_OPS_META_KEY,
	ORDER_OPS_EVENT,
	ORDER_OPS_NEW_ORDERS_EVENT,
	maxOrderOpsVersion,
	mergeOrderOpsVersions,
	OrderOpsDomain,
	OrderOpsMeta,
	OrderOpsNewOrdersDetail,
	OrderOpsSnapshot,
	OrderOpsVersions,
	ORDER_OPS_DOMAINS,
	ZERO_ORDER_OPS_VERSIONS,
	versionsFromLegacyStateVersion,
} from '@/src/models/order_ops';
import { BILLING_SESSIONS_KEY, TOrdersStore } from '@/src/models/common';
import { getInventorySnapshotForDate, getTodayDateKey } from '@/src/utils/inventory_utils';
import { getTodayOrderHistory } from '@/src/utils/order_history';
import { getOrdersStore, maintainOrders } from '@/src/utils/order_utils';
import { getDailyOrderNumberSnapshot } from '@/src/utils/daily_order_number';
import { getDayChecklistSnapshotForDate, pruneDayChecklistsForToday } from '@/src/utils/day_checklist_utils';
import { getSupplyInventorySnapshotForDate } from '@/src/utils/supply_inventory_utils';
import { getWaitlistSnapshotForDate } from '@/src/utils/waitlist_utils';
import { getServiceRequestsSnapshotForDate } from '@/src/utils/service_requests_utils';
import { getBillingSessions } from '@/src/utils/billing_state';
import {
	BILL_PRINTER_DEVICE_NAME,
	KOT_PRINTER_DEVICE_NAME,
} from '@/src/utils/print_servers';
import localforage from 'localforage';

const DEVICE_ID_PATTERN =
	/^device-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reserved presence names for tangify-billing-server-hub — clients must not use them. */
export const SYNC_HUB_DEVICE_NAME = 'Tangify Sync Hub';
export const SYNC_HUB_DEV_DEVICE_NAME = 'Tangify Sync Hub Dev';
export const KOT_PRINTER_RESERVED_NAME = KOT_PRINTER_DEVICE_NAME;
export const BILL_PRINTER_RESERVED_NAME = BILL_PRINTER_DEVICE_NAME;

function isSyncHubDeviceDisplayName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return (
		normalized === SYNC_HUB_DEVICE_NAME.toLowerCase() ||
		normalized === SYNC_HUB_DEV_DEVICE_NAME.toLowerCase()
	);
}

export function isReservedDeviceDisplayName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return (
		isSyncHubDeviceDisplayName(normalized) ||
		normalized === KOT_PRINTER_RESERVED_NAME.toLowerCase() ||
		normalized === BILL_PRINTER_RESERVED_NAME.toLowerCase()
	);
}

export function getStableDeviceId(): string {
	if (typeof window === 'undefined') {
		return 'device-server';
	}

	const existing = localStorage.getItem(ORDER_OPS_DEVICE_ID_KEY);
	if (existing && DEVICE_ID_PATTERN.test(existing)) {
		return existing;
	}

	const id = `device-${crypto.randomUUID()}`;
	localStorage.setItem(ORDER_OPS_DEVICE_ID_KEY, id);
	return id;
}

export function getDeviceDisplayName(): string {
	if (typeof window === 'undefined') {
		return 'Server';
	}

	const custom = localStorage.getItem(ORDER_OPS_DEVICE_NAME_KEY)?.trim();
	if (custom) {
		if (isReservedDeviceDisplayName(custom)) {
			localStorage.removeItem(ORDER_OPS_DEVICE_NAME_KEY);
		} else {
			return custom;
		}
	}

	const id = getStableDeviceId();
	return `Device ${id.slice(-4)}`;
}

/** True when the user has set a custom device name (not the auto fallback). */
export function hasDeviceDisplayName(): boolean {
	if (typeof window === 'undefined') {
		return true;
	}
	const custom = localStorage.getItem(ORDER_OPS_DEVICE_NAME_KEY)?.trim();
	if (!custom) {
		return false;
	}
	if (isReservedDeviceDisplayName(custom)) {
		localStorage.removeItem(ORDER_OPS_DEVICE_NAME_KEY);
		return false;
	}
	return true;
}

export function setDeviceDisplayName(name: string): void {
	if (typeof window === 'undefined') {
		return;
	}

	const trimmed = name.trim();
	if (!trimmed) {
		localStorage.removeItem(ORDER_OPS_DEVICE_NAME_KEY);
		return;
	}

	if (isReservedDeviceDisplayName(trimmed)) {
		throw new Error(
			`“${trimmed}” is reserved (sync hub / KOT Printer / Bill Printer). Choose another name.`
		);
	}

	localStorage.setItem(ORDER_OPS_DEVICE_NAME_KEY, trimmed);
}

function nextDomainVersion(current: number): number {
	return Math.max(current + 1, Date.now());
}

function migrateMetaVersions(stored: OrderOpsMeta): OrderOpsVersions {
	if (stored.versions) {
		return mergeOrderOpsVersions(ZERO_ORDER_OPS_VERSIONS, stored.versions);
	}
	return versionsFromLegacyStateVersion(stored.stateVersion ?? 0);
}

function createFreshMeta(deviceId: string): OrderOpsMeta {
	return {
		deviceId,
		versions: { ...ZERO_ORDER_OPS_VERSIONS },
		businessDate: getTodayDateKey(),
		lastUpdatedAt: Date.now(),
		initializedForToday: false,
	};
}

function normalizeMetaForToday(stored: OrderOpsMeta, today: string): OrderOpsMeta {
	const versions = migrateMetaVersions(stored);

	if (stored.businessDate !== today) {
		return {
			deviceId: stored.deviceId,
			versions: { ...ZERO_ORDER_OPS_VERSIONS },
			businessDate: today,
			lastUpdatedAt: Date.now(),
			initializedForToday: false,
		};
	}

	return {
		deviceId: stored.deviceId,
		versions,
		businessDate: today,
		lastUpdatedAt: stored.lastUpdatedAt,
		initializedForToday:
			stored.initializedForToday ?? maxOrderOpsVersion(versions) > 0,
	};
}

export async function getOrderOpsMeta(): Promise<OrderOpsMeta> {
	const deviceId = getStableDeviceId();
	const today = getTodayDateKey();
	const stored = await localforage.getItem<OrderOpsMeta>(ORDER_OPS_META_KEY);

	if (!stored || stored.deviceId !== deviceId) {
		const meta = createFreshMeta(deviceId);
		await localforage.setItem(ORDER_OPS_META_KEY, meta);
		return meta;
	}

	const meta = normalizeMetaForToday(stored, today);
	if (stored.businessDate !== today) {
		await pruneDayChecklistsForToday(today);
		// Abandoned checkouts accumulate and blow Ably's 64KiB state:delta limit.
		await localforage.setItem(BILLING_SESSIONS_KEY, {});
	}
	const storedVersions = migrateMetaVersions(stored);
	const versionsChanged = ORDER_OPS_DOMAINS.some(
		(domain) => meta.versions[domain] !== storedVersions[domain]
	);
	if (
		meta.businessDate !== stored.businessDate ||
		versionsChanged ||
		meta.initializedForToday !== stored.initializedForToday
	) {
		await localforage.setItem(ORDER_OPS_META_KEY, meta);
	}
	return meta;
}

export async function bumpOrderOpsDomain(
	domain: OrderOpsDomain,
	meta?: OrderOpsMeta
): Promise<OrderOpsMeta> {
	const current = meta ?? (await getOrderOpsMeta());
	const today = getTodayDateKey();
	const next: OrderOpsMeta = {
		...current,
		versions: {
			...current.versions,
			[domain]: nextDomainVersion(current.versions[domain]),
		},
		businessDate: today,
		lastUpdatedAt: Date.now(),
		initializedForToday: true,
	};
	await localforage.setItem(ORDER_OPS_META_KEY, next);
	return next;
}

export async function bumpAllOrderOpsDomains(): Promise<OrderOpsMeta> {
	let meta = await getOrderOpsMeta();
	for (const domain of ORDER_OPS_DOMAINS) {
		meta = await bumpOrderOpsDomain(domain, meta);
	}
	return meta;
}

/** @deprecated Use bumpOrderOpsDomain(domain) */
export async function bumpOrderOpsMeta(): Promise<OrderOpsMeta> {
	return bumpAllOrderOpsDomains();
}

export async function setOrderOpsMetaVersions(
	versions: OrderOpsVersions,
	businessDate: string
): Promise<OrderOpsMeta> {
	const meta = await getOrderOpsMeta();
	const next: OrderOpsMeta = {
		...meta,
		versions: mergeOrderOpsVersions(meta.versions, versions),
		businessDate,
		lastUpdatedAt: Date.now(),
		initializedForToday: true,
	};
	await localforage.setItem(ORDER_OPS_META_KEY, next);
	return next;
}

export async function buildOrderOpsSnapshot(): Promise<OrderOpsSnapshot> {
	const meta = await getOrderOpsMeta();
	const businessDate = getTodayDateKey();
	const store: TOrdersStore = await getOrdersStore();
	const orders = maintainOrders(store.orders, Date.now());
	const inventory = await getInventorySnapshotForDate(businessDate);
	const orderHistory = await getTodayOrderHistory();
	const [dayChecklists, supplyInventory, waitlist, serviceRequests, billingSessions, nextOrderNumber] =
		await Promise.all([
			getDayChecklistSnapshotForDate(businessDate),
			getSupplyInventorySnapshotForDate(businessDate),
			getWaitlistSnapshotForDate(businessDate),
			getServiceRequestsSnapshotForDate(businessDate),
			getBillingSessions(),
			getDailyOrderNumberSnapshot(),
		]);

	return {
		deviceId: meta.deviceId,
		versions: meta.versions,
		stateVersion: maxOrderOpsVersion(meta.versions),
		businessDate,
		orders,
		inventory,
		orderHistory,
		nextOrderNumber,
		dayChecklists,
		supplyInventory,
		waitlist,
		serviceRequests,
		billingSessions,
		sentAt: Date.now(),
	};
}

/** Version vector for a single-domain live notify — other domains stay at 0 (omitted). */
function domainSnapshotVersions(
	meta: OrderOpsMeta,
	domain: OrderOpsDomain
): OrderOpsVersions {
	return {
		...ZERO_ORDER_OPS_VERSIONS,
		[domain]: meta.versions[domain],
	};
}

function partialSnapshotBase(
	meta: OrderOpsMeta,
	businessDate: string,
	domain: OrderOpsDomain
): OrderOpsSnapshot {
	const domainVersion = meta.versions[domain];
	return {
		deviceId: meta.deviceId,
		versions: domainSnapshotVersions(meta, domain),
		stateVersion: domainVersion,
		businessDate,
		sentAt: Date.now(),
	};
}

/** Live notify payload: only the changed domain. Catch-up still uses the full snapshot. */
export async function buildOrderOpsDomainSnapshot(
	domain: OrderOpsDomain
): Promise<OrderOpsSnapshot> {
	const meta = await getOrderOpsMeta();
	const businessDate = getTodayDateKey();
	const base = partialSnapshotBase(meta, businessDate, domain);

	if (domain === 'orders') {
		const store: TOrdersStore = await getOrdersStore();
		const [orderHistory, nextOrderNumber] = await Promise.all([
			getTodayOrderHistory(),
			getDailyOrderNumberSnapshot(),
		]);
		return {
			...base,
			orders: maintainOrders(store.orders, Date.now()),
			orderHistory,
			nextOrderNumber,
		};
	}

	if (domain === 'inventory') {
		return {
			...base,
			inventory: await getInventorySnapshotForDate(businessDate),
		};
	}

	if (domain === 'dayChecklists') {
		return {
			...base,
			dayChecklists: await getDayChecklistSnapshotForDate(businessDate),
		};
	}

	if (domain === 'supplyInventory') {
		return {
			...base,
			supplyInventory: await getSupplyInventorySnapshotForDate(businessDate),
		};
	}

	if (domain === 'waitlist') {
		return {
			...base,
			waitlist: await getWaitlistSnapshotForDate(businessDate),
		};
	}

	if (domain === 'serviceRequests') {
		return {
			...base,
			serviceRequests: await getServiceRequestsSnapshotForDate(businessDate),
		};
	}

	return {
		...base,
		billingSessions: await getBillingSessions(),
	};
}

export type OrderOpsUpdatedDetail = {
	domain: OrderOpsDomain | 'all';
};

export function dispatchOrderOpsUpdated(
	domain: OrderOpsDomain | 'all' = 'all'
): void {
	if (typeof window === 'undefined') {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<OrderOpsUpdatedDetail>(ORDER_OPS_EVENT, {
			detail: { domain },
		})
	);
}

export function dispatchNewOrdersSynced(orderIds: string[]): void {
	if (typeof window === 'undefined' || orderIds.length === 0) {
		return;
	}

	const detail: OrderOpsNewOrdersDetail = {
		orderIds,
		count: orderIds.length,
	};
	window.dispatchEvent(
		new CustomEvent<OrderOpsNewOrdersDetail>(ORDER_OPS_NEW_ORDERS_EVENT, {
			detail,
		})
	);
}

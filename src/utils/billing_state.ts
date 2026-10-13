import {
	BillingContext,
	BILLING_CONTEXT_KEY,
	BILLING_SESSIONS_KEY,
	BillingSessionState,
	TBill,
	TCart,
} from '@/src/models/common';
import localforage from 'localforage';

type BillingSessionsStore = Record<string, BillingSessionState>;

export async function getBillingSessions(): Promise<BillingSessionState[]> {
	const store =
		(await localforage.getItem<BillingSessionsStore>(BILLING_SESSIONS_KEY)) ?? {};
	return Object.values(store);
}

export async function getBillingSession(
	sessionId: string
): Promise<BillingSessionState | null> {
	const store =
		(await localforage.getItem<BillingSessionsStore>(BILLING_SESSIONS_KEY)) ?? {};
	return store[sessionId] ?? null;
}

export async function saveBillingSession(
	context: BillingContext,
	cart: TCart,
	bill?: TBill
): Promise<BillingSessionState> {
	const store =
		(await localforage.getItem<BillingSessionsStore>(BILLING_SESSIONS_KEY)) ?? {};
	const previous = store[context.sessionId];
	const nextBill = bill ?? previous?.bill;
	const updatedAt = nextBill?.updatedAt ?? Date.now();
	const session: BillingSessionState = {
		sessionId: context.sessionId,
		context,
		cart,
		...(nextBill ? { bill: nextBill } : {}),
		updatedAt,
	};
	store[context.sessionId] = session;
	await localforage.setItem(BILLING_SESSIONS_KEY, store);
	return session;
}

export async function removeBillingSession(sessionId: string): Promise<void> {
	const store =
		(await localforage.getItem<BillingSessionsStore>(BILLING_SESSIONS_KEY)) ?? {};
	delete store[sessionId];
	await localforage.setItem(BILLING_SESSIONS_KEY, store);
}

export async function applyBillingSessions(
	sessions: BillingSessionState[]
): Promise<void> {
	const next = Object.fromEntries(
		sessions.map((session) => [session.sessionId, session])
	) as BillingSessionsStore;
	await localforage.setItem(BILLING_SESSIONS_KEY, next);

	const activeContext =
		await localforage.getItem<BillingContext>(BILLING_CONTEXT_KEY);
	if (!activeContext) {
		return;
	}

	const active = next[activeContext.sessionId];
	if (!active) {
		await localforage.removeItem(BILLING_CONTEXT_KEY);
		await localforage.setItem('cart', { items: [] });
		await localforage.setItem('bill', null);
		return;
	}

	await localforage.setItem(BILLING_CONTEXT_KEY, active.context);
	await localforage.setItem('cart', active.cart);
	if (active.bill) {
		// Sync may omit nested bill.cart (duplicate of session.cart) to stay under Ably limits.
		const billCart =
			active.bill.cart?.items?.length > 0 ? active.bill.cart : active.cart;
		await localforage.setItem('bill', { ...active.bill, cart: billCart });
	}
}


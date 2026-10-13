"use client";

import { ItemGroup, OrderGroup, TBill, TCart, TOrder, TOrdersStore, BillingContext, BILLING_CONTEXT_KEY, ItemCancelReason, TABLE_COUNT, isCounterOrderKind } from "@/src/models/common";
import {
	formatOrderLabel,
	formatOrderTime,
	getGroupCustomerDetails,
	getGroupNotes,
	getGroupPax,
	fulfillNextUnitForDish,
	getGroupLateByMs,
	getOrderLateByMs,
	getOrderItemUnitDisplay,
	getReadyOrders,
	getItemUnitStates,
	getUnitCancelReason,
	groupItemsByKitchenGroup,
	groupOrdersByTable,
	formatLateDuration,
	isGroupFullyMarkedDone,
	isGroupLate,
	isOrderLate,
	isOrderEditable,
	isOrderMarkedDone,
	isOrderReady,
	isTableComplementaryServed,
	isTableKidMenuEnabled,
	isTableKidMenuServed,
	isTableWelcomeDrinkServed,
	isItemUnitParcel,
	isUnitPending,
	maintainOrders,
	markOrderDone,
	markTableComplementaryServed,
	markTableKidMenuServed,
	markTableWelcomeDrinkServed,
	orderGroupToBillCart,
	groupHasBillableItems,
	closeTableFromBilling,
	discardOrderGroup,
	ordersStoreChanged,
	emptyWaterBottleCounts,
	emptyWaterBottleDrafts,
	getGroupWaterBottleCounts,
	syncGroupWaterBottleCount,
	getWaterBottlePrices,
	WATER_DISH_NAMES,
	type WaterDishName,
	canMoveTableGroupToTables,
	formatTableGroupLabel,
	getOccupiedTableNumbers,
	isTableAvailableForGroupMove,
	moveTableGroupToTables,
	normalizeTableNumbers,
	tableNumbersEqual,
	isUnitLastFulfilled,
	isUnitNextToFulfill,
	unfulfillLastUnitForDish,
	updateGroupNotes,
	updateGroupPax,
	updateGroupCustomerPhone,
	updateOrders,
	cancelItemUnit,
	toggleItemUnitParcel,
	setItemUnitFulfilled,
	buildNewOrderHref,
	CUSTOMER_PHONE_DIGITS,
	isValidCustomerPhone,
} from "@/src/utils/order_utils";
import {
	decrementInventoryForOrder,
	getTodayDateKey,
	replenishInventoryForOrder,
} from "@/src/utils/inventory_utils";
import { buildDishCategoryMap } from "@/src/utils/menu_utils";
import {
	getAllDayChecklistItemIds,
	type DayChecklistKind,
} from "@/src/constants/day_checklists";
import { getDayChecklistForDate } from "@/src/utils/day_checklist_utils";
import { itemCancelReasonLabel } from "@/src/utils/item_cancel_reasons";
import { formatDailyOrderNumber } from "@/src/utils/daily_order_number";
import { EditOrderModal } from "@/components/feature/order/edit-order-modal";
import { CancelItemModal } from "@/components/feature/order/cancel-item-modal";
import { OrderOpsSyncIndicator } from "@/components/feature/order/order-ops-sync-indicator";
import { OpsMenuButton } from "@/components/feature/layout/ops-drawer";
import {
	ConfirmModalActions,
	LoadingSpinner,
	TouchActionButton,
	TouchIconButton,
} from "@/components/ui/touch-controls";
import { ORDER_OPS_EVENT } from "@/src/models/order_ops";
import { saveBillingSession } from "@/src/utils/billing_state";
import { notifyOrderOpsChange } from "@/src/utils/order_ops_sync";
import { getMenuItemsPreferCache } from "@/src/utils/menu_cache";
import type { OrderOpsUpdatedDetail } from "@/src/utils/order_ops_meta";
import { LateClockProvider, useLateClock } from "@/components/feature/order/late-clock";
import { useInFlightLock } from "@/src/utils/in_flight";
import {
	canEditSession,
	claimGroupSessionLock,
	claimSessionLockForOrder,
	findOrderGroupByKey,
	findOrderGroupForOrder,
	getGroupSessionLock,
	isSessionLockedByOther,
} from "@/src/utils/session_lock";
import { useOrderOpsSync } from "@/context/order-ops-sync";
import localforage from "localforage";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const ORDERS_KEY = "orders";

type TabId = "tables" | "items";
type TableOrdersView = "groups" | "orders";

function orderMatchesTableFilter(
	order: TOrder,
	selectedTables: Set<number>
): boolean {
	if (selectedTables.size === 0) {
		return true;
	}
	if (order.kind !== "table") {
		return false;
	}
	return (order.tableNumbers ?? []).some((tableNumber) =>
		selectedTables.has(tableNumber)
	);
}

function groupMatchesTableFilter(
	group: OrderGroup,
	selectedTables: Set<number>
): boolean {
	if (selectedTables.size === 0) {
		return true;
	}
	if (group.kind !== "table") {
		return false;
	}
	return (group.tableNumbers ?? []).some((tableNumber) =>
		selectedTables.has(tableNumber)
	);
}

function filterItemGroupByTables(
	group: ItemGroup,
	orders: TOrder[],
	selectedTables: Set<number>
): ItemGroup | null {
	if (selectedTables.size === 0) {
		return group;
	}

	const orderById = new Map(orders.map((order) => [order.id, order]));
	const units = group.units.filter((unit) => {
		const order = orderById.get(unit.orderId);
		return order != null && orderMatchesTableFilter(order, selectedTables);
	});

	if (units.length === 0) {
		return null;
	}

	return {
		...group,
		units,
		totalQty: units.length,
		remainingQty: units.filter((unit) => isUnitPending(unit)).length,
	};
}

function FilterIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<path d="M4 6h16" />
			<path d="M6 12h12" />
			<path d="M10 18h4" />
		</svg>
	);
}

function OrderViewFiltersSheet({
	activeTab,
	onActiveTabChange,
	tableOrdersView,
	onTableOrdersViewChange,
	itemsAggregatesView,
	onItemsAggregatesViewChange,
	onClose,
}: {
	activeTab: TabId;
	onActiveTabChange: (tab: TabId) => void;
	tableOrdersView: TableOrdersView;
	onTableOrdersViewChange: (view: TableOrdersView) => void;
	itemsAggregatesView: boolean;
	onItemsAggregatesViewChange: (aggregates: boolean) => void;
	onClose: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-0"
			onClick={onClose}
		>
			<div
				className="w-full max-w-md rounded-t-xl bg-white shadow-xl max-h-[85vh] flex flex-col pb-[env(safe-area-inset-bottom)]"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-lg font-bold">View filters</h2>
						<button
							type="button"
							onClick={onClose}
							className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-green-500 text-white hover:bg-green-600 active:bg-green-700 touch-manipulation shrink-0"
							aria-label="Apply filters"
						>
							<CheckIcon checked className="w-5 h-5" />
						</button>
					</div>
				</div>
				<div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
					<div>
						<p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
							View
						</p>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => onActiveTabChange("tables")}
								className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-lg text-sm font-semibold touch-manipulation transition-colors ${
									activeTab === "tables"
										? "bg-black text-white"
										: "bg-gray-100 text-gray-700 active:bg-gray-200 border border-gray-300"
								}`}
							>
								Table orders
							</button>
							<button
								type="button"
								onClick={() => onActiveTabChange("items")}
								className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-lg text-sm font-semibold touch-manipulation transition-colors ${
									activeTab === "items"
										? "bg-black text-white"
										: "bg-gray-100 text-gray-700 active:bg-gray-200 border border-gray-300"
								}`}
							>
								By item
							</button>
						</div>
					</div>
					<div>
						<p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
							{activeTab === "tables" ? "Table orders layout" : "By item layout"}
						</p>
						<div className="flex gap-2">
							{activeTab === "tables" ? (
								<>
									<button
										type="button"
										onClick={() => onTableOrdersViewChange("groups")}
										className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-lg text-sm font-semibold touch-manipulation transition-colors ${
											tableOrdersView === "groups"
												? "bg-gray-800 text-white"
												: "bg-gray-100 text-gray-700 active:bg-gray-200 border border-gray-300"
										}`}
									>
										By table
									</button>
									<button
										type="button"
										onClick={() => onTableOrdersViewChange("orders")}
										className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-lg text-sm font-semibold touch-manipulation transition-colors ${
											tableOrdersView === "orders"
												? "bg-gray-800 text-white"
												: "bg-gray-100 text-gray-700 active:bg-gray-200 border border-gray-300"
										}`}
									>
										All orders
									</button>
								</>
							) : (
								<>
									<button
										type="button"
										onClick={() => onItemsAggregatesViewChange(false)}
										className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-lg text-sm font-semibold touch-manipulation transition-colors ${
											!itemsAggregatesView
												? "bg-gray-800 text-white"
												: "bg-gray-100 text-gray-700 active:bg-gray-200 border border-gray-300"
										}`}
									>
										Each item
									</button>
									<button
										type="button"
										onClick={() => onItemsAggregatesViewChange(true)}
										className={`flex-1 min-h-[40px] px-2 py-1.5 rounded-lg text-sm font-semibold touch-manipulation transition-colors ${
											itemsAggregatesView
												? "bg-gray-800 text-white"
												: "bg-gray-100 text-gray-700 active:bg-gray-200 border border-gray-300"
										}`}
									>
										Aggregates
									</button>
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function PlusIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</svg>
	);
}

function PhoneIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
		</svg>
	);
}

function CheckIcon({
	checked,
	className,
}: {
	checked: boolean;
	className?: string;
}) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			{checked ? (
				<>
					<path d="M20 6 9 17l-5-5" />
				</>
			) : (
				<rect x="4" y="4" width="16" height="16" rx="2" />
			)}
		</svg>
	);
}

function QtyBadge({ qty }: { qty: number }) {
	return (
		<span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-black text-white text-[10px] font-bold leading-none shrink-0">
			{qty}
		</span>
	);
}

function MoreVerticalIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="currentColor"
			className={className}
			aria-hidden
		>
			<circle cx="12" cy="5" r="1.75" />
			<circle cx="12" cy="12" r="1.75" />
			<circle cx="12" cy="19" r="1.75" />
		</svg>
	);
}

function TableStatusDot({
	label,
	children,
	done = true,
	className = "",
}: {
	label: string;
	children: ReactNode;
	done?: boolean;
	className?: string;
}) {
	return (
		<span
			className={`inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full border px-1 text-[10px] font-bold leading-none shadow-md ${
				done
					? "bg-green-100 border-green-600 text-green-800"
					: "bg-amber-50 border-amber-400 text-amber-900"
			} ${className}`}
			title={label}
			aria-label={label}
		>
			{children}
		</span>
	);
}

function TableNamePopover({
	label,
	onClose,
}: {
	label: string;
	onClose: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 px-6"
			onClick={onClose}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white px-5 py-4 shadow-xl text-center"
				onClick={(event) => event.stopPropagation()}
			>
				<p className="text-lg font-bold text-gray-900 break-words">{label}</p>
				<button
					type="button"
					onClick={onClose}
					className="mt-4 min-h-[40px] w-full rounded-lg bg-gray-100 text-sm font-semibold text-gray-800 touch-manipulation active:bg-gray-200"
				>
					Close
				</button>
			</div>
		</div>
	);
}

function TableGroupMoreSheet({
	group,
	hasOrdersInGroup,
	groupPax,
	groupNotes,
	showTableService,
	drinkServed,
	compServed,
	kidEnabled,
	kidServed,
	billingPending,
	changeTablePending,
	drinkPending,
	compPending,
	kidPending,
	notesPending,
	paxPending,
	closePending,
	sessionEditable,
	lockHolderName,
	acquirePending,
	onAcquireLock,
	onBill,
	onChangeTable,
	onEditNotes,
	onEditPax,
	onCloseOrder,
	onRequestWelcomeDrink,
	onRequestComplementary,
	onRequestKidMenu,
	onClose,
}: {
	group: OrderGroup;
	hasOrdersInGroup: boolean;
	groupPax: number | null;
	groupNotes: string | null;
	showTableService: boolean;
	drinkServed: boolean;
	compServed: boolean;
	kidEnabled: boolean;
	kidServed: boolean;
	billingPending: boolean;
	changeTablePending: boolean;
	drinkPending: boolean;
	compPending: boolean;
	kidPending: boolean;
	notesPending: boolean;
	paxPending: boolean;
	closePending: boolean;
	sessionEditable: boolean;
	lockHolderName: string | null;
	acquirePending: boolean;
	onAcquireLock: (group: OrderGroup) => void;
	onBill: (group: OrderGroup) => void;
	onChangeTable: (group: OrderGroup) => void;
	onEditNotes: (group: OrderGroup) => void;
	onEditPax: (group: OrderGroup) => void;
	onCloseOrder: (group: OrderGroup) => void;
	onRequestWelcomeDrink: (group: OrderGroup) => void;
	onRequestComplementary: (group: OrderGroup) => void;
	onRequestKidMenu: (group: OrderGroup) => void;
	onClose: () => void;
}) {
	const editsDisabled = !sessionEditable;
	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-0"
			onClick={onClose}
		>
			<div
				className="w-full max-w-md rounded-t-xl bg-white shadow-xl max-h-[85vh] flex flex-col pb-[env(safe-area-inset-bottom)]"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-lg font-bold truncate">{group.label}</h2>
						<button
							type="button"
							onClick={onClose}
							className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-green-500 text-white hover:bg-green-600 active:bg-green-700 touch-manipulation shrink-0"
							aria-label="Close"
						>
							<CheckIcon checked className="w-5 h-5" />
						</button>
					</div>
					{editsDisabled && lockHolderName ? (
						<p className="text-sm text-amber-800 mt-2">
							Locked by {lockHolderName}. Acquire the lock to edit.
						</p>
					) : null}
				</div>
				<div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
					{editsDisabled && lockHolderName ? (
						<TouchActionButton
							onClick={() => {
								onClose();
								onAcquireLock(group);
							}}
							loading={acquirePending}
							disabled={acquirePending}
							className="w-full rounded-xl bg-amber-500 border border-amber-600 text-white active:bg-amber-600 disabled:opacity-40 min-h-[44px]"
						>
							Acquire lock from {lockHolderName}
						</TouchActionButton>
					) : null}
					<TouchActionButton
						onClick={() => {
							onClose();
							onBill(group);
						}}
						loading={billingPending}
						disabled={!hasOrdersInGroup || billingPending || editsDisabled}
						className="w-full rounded-xl bg-green-500 border border-green-600 text-white active:bg-green-600 disabled:opacity-40 min-h-[44px]"
					>
						₹ Bill
					</TouchActionButton>
					{group.kind === "table" ? (
						<TouchActionButton
							onClick={() => {
								onClose();
								onChangeTable(group);
							}}
							loading={changeTablePending}
							disabled={
								!hasOrdersInGroup || changeTablePending || editsDisabled
							}
							className="w-full rounded-xl bg-white border border-gray-300 text-gray-700 active:bg-gray-100 disabled:opacity-40 min-h-[44px]"
						>
							Change table
						</TouchActionButton>
					) : null}
					<button
						type="button"
						onClick={() => {
							onClose();
							onEditNotes(group);
						}}
						disabled={notesPending || editsDisabled}
						className={`w-full min-h-[44px] rounded-xl border text-sm font-semibold touch-manipulation disabled:opacity-50 ${
							groupNotes
								? "border-green-600 bg-green-50 text-green-800"
								: "border-gray-300 bg-white text-gray-700 active:bg-gray-100"
						}`}
					>
						{notesPending ? "Saving notes…" : groupNotes ? "Edit notes" : "Add notes"}
					</button>
					{groupPax != null ? (
						<div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
							<span className="flex-1 text-sm font-semibold text-gray-800">
								{groupPax} pax
							</span>
							<button
								type="button"
								onClick={() => {
									onClose();
									onEditPax(group);
								}}
								disabled={paxPending || editsDisabled}
								className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 active:bg-gray-200 touch-manipulation disabled:opacity-50"
								aria-label="Edit pax"
							>
								<PencilIcon className="w-3.5 h-3.5" />
								Edit
							</button>
						</div>
					) : (
						<button
							type="button"
							onClick={() => {
								onClose();
								onEditPax(group);
							}}
							disabled={paxPending || editsDisabled}
							className="w-full min-h-[44px] rounded-xl border border-gray-300 bg-white text-sm font-semibold text-gray-700 active:bg-gray-100 touch-manipulation disabled:opacity-50"
						>
							{paxPending ? "Saving pax…" : "Add pax"}
						</button>
					)}
					{showTableService ? (
						<div className="flex flex-wrap gap-2 pt-1">
							<TableServicePill
								label="🥤 Drink"
								checked={drinkServed}
								loading={drinkPending}
								onClick={() => {
									if (editsDisabled) return;
									onRequestWelcomeDrink(group);
								}}
							/>
							<TableServicePill
								label="🫓 Complementary"
								checked={compServed}
								loading={compPending}
								onClick={() => {
									if (editsDisabled) return;
									onRequestComplementary(group);
								}}
							/>
							{kidEnabled ? (
								<TableServicePill
									label="👶 Kid"
									checked={kidServed}
									loading={kidPending}
									onClick={() => {
										if (editsDisabled) return;
										onRequestKidMenu(group);
									}}
								/>
							) : null}
						</div>
					) : null}
					<button
						type="button"
						onClick={() => {
							onClose();
							onCloseOrder(group);
						}}
						disabled={!hasOrdersInGroup || closePending || editsDisabled}
						className="w-full min-h-[44px] rounded-xl border border-red-600 bg-red-600 text-sm font-semibold text-white active:bg-red-700 touch-manipulation disabled:opacity-40"
					>
						{closePending ? "Closing…" : "Close order"}
					</button>
				</div>
			</div>
		</div>
	);
}

function PencilIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	);
}

function CrossIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

function OrderRow({
	order,
	sessionEditable = true,
	onEdit,
	onKotPrint,
	onRequestMarkDone,
	onRequestCancelItem,
	onRequestToggleParcel,
	onRequestToggleFulfill,
}: {
	order: TOrder;
	sessionEditable?: boolean;
	onEdit: (order: TOrder) => void;
	onKotPrint: (order: TOrder) => void;
	onRequestMarkDone: (order: TOrder) => void;
	onRequestCancelItem: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onRequestToggleParcel: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onRequestToggleFulfill: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
}) {
	const markedDone = isOrderMarkedDone(order);
	const editable = isOrderEditable(order) && sessionEditable;
	const canToggleParcel = sessionEditable;
	const kitchenReady = isOrderReady(order);
	const canMarkDone = kitchenReady && !markedDone && sessionEditable;
	const orderSerial = formatDailyOrderNumber(order.orderNumber);
	const kotPrinted = order.kotPrintedAt != null;

	return (
		<div
			className={`relative border rounded-lg px-3 py-2 bg-gray-50 ${
				markedDone ? "border-green-200 bg-green-50/40" : "border-gray-100"
			}`}
		>
			<div className="mb-2 space-y-2">
				<div className="flex items-center gap-2">
					{orderSerial ? (
						<span
							className="inline-flex h-9 min-w-[2.25rem] shrink-0 items-center justify-center rounded-lg bg-black px-2.5 text-sm font-black text-white tabular-nums"
							aria-label={`Order ${orderSerial}`}
						>
							{orderSerial}
						</span>
					) : null}
					<button
						type="button"
						onClick={() => onKotPrint(order)}
						className="inline-flex h-9 min-w-[2.25rem] shrink-0 items-center justify-center gap-1 rounded-full border border-yellow-400 bg-yellow-100 px-3 text-xs font-semibold text-yellow-900 touch-manipulation active:bg-yellow-200"
					>
						KOT
						{kotPrinted ? (
							<span
								className="text-green-700"
								aria-label="KOT printed"
								title="KOT printed"
							>
								✓
							</span>
						) : null}
					</button>
					<span className="min-w-0 flex-1" aria-hidden />
					{editable ? (
						<TouchIconButton
							onClick={() => onEdit(order)}
							ariaLabel={`Edit order from ${formatOrderTime(order.createdAt)}`}
							className="bg-white text-gray-600 hover:bg-gray-100 border border-gray-200 shrink-0 -mr-1"
						>
							<PencilIcon className="w-4 h-4" />
						</TouchIconButton>
					) : null}
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						role="checkbox"
						aria-checked={markedDone}
						disabled={!canMarkDone && !markedDone}
						title={
							!markedDone && !kitchenReady
								? "Mark each item ready or cancelled on the By item tab, or cancel from here"
								: undefined
						}
						onClick={() => {
							if (canMarkDone) {
								onRequestMarkDone(order);
							}
						}}
						className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold touch-manipulation shrink-0 transition-colors ${
							!canMarkDone && !markedDone
								? "cursor-not-allowed opacity-50 border-gray-200 bg-white text-gray-400"
								: markedDone
									? "border-green-600 bg-green-100 text-green-800"
									: "border-gray-300 bg-white text-gray-700 active:bg-gray-100"
						}`}
					>
						<span
							className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
								markedDone
									? "border-green-600 bg-green-600 text-white"
									: "border-gray-300 bg-white"
							}`}
						>
							{markedDone ? (
								<svg
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="3"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="h-2.5 w-2.5"
									aria-hidden
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							) : null}
						</span>
						Done
					</button>
					<span className="text-xs font-semibold text-gray-600 truncate min-w-0">
						{formatOrderTime(order.createdAt)}
					</span>
				</div>
			</div>
			{order.notes?.trim() ? (
				<p className="text-xs text-gray-500 mb-1.5 italic">
					Note: {order.notes.trim()}
				</p>
			) : null}
			<ul className="space-y-1">
				{order.items.map((item, itemIndex) => {
					const unitDisplays = Array.from({ length: item.qty }, (_, unitIndex) =>
						getOrderItemUnitDisplay(item, unitIndex)
					);
					const cancelReasons = Array.from({ length: item.qty }, (_, unitIndex) =>
						getUnitCancelReason(getItemUnitStates(item)[unitIndex] ?? "pending")
					);
					return (
						<li
							key={`${order.id}-${item.name}-${itemIndex}`}
							className="text-sm text-gray-700"
						>
							<div className="flex items-center gap-2 flex-wrap">
								<QtyBadge qty={item.qty} />
								<span
									className={`font-medium leading-snug ${
										unitDisplays.every((display) => display === "cancelled")
											? "line-through text-gray-400"
											: ""
									}`}
								>
									{item.name}
								</span>
								<span className="inline-flex items-center gap-1 ml-1 flex-wrap">
									{unitDisplays.map((display, unitIndex) => {
										const isParcel = isItemUnitParcel(item, unitIndex);
										return (
										<span
											key={unitIndex}
											className="inline-flex items-center gap-0.5"
											title={
												display === "cancelled" && cancelReasons[unitIndex]
													? itemCancelReasonLabel(cancelReasons[unitIndex]!)
													: isParcel
														? "Parcel"
														: undefined
											}
										>
											{display === "cancelled" ? (
												<CrossIcon className="w-4 h-4 shrink-0 text-red-500" />
											) : markedDone ? (
												<CheckIcon
													checked={display === "fulfilled"}
													className={`w-4 h-4 shrink-0 ${
														display === "fulfilled"
															? "text-green-600"
															: "text-gray-300"
													}`}
												/>
											) : editable ? (
												<button
													type="button"
													onClick={() =>
														onRequestToggleFulfill(order, itemIndex, unitIndex)
													}
													className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border touch-manipulation ${
														display === "fulfilled"
															? "border-green-300 bg-green-50 text-green-600 active:bg-green-100"
															: "border-gray-200 bg-white text-gray-400 active:bg-gray-100"
													}`}
													aria-label={`${
														display === "fulfilled" ? "Unmark" : "Mark"
													} ${item.name} done`}
													aria-pressed={display === "fulfilled"}
												>
													<CheckIcon
														checked={display === "fulfilled"}
														className="w-5 h-5"
													/>
												</button>
											) : (
												<CheckIcon
													checked={display === "fulfilled"}
													className={`w-4 h-4 shrink-0 ${
														display === "fulfilled"
															? "text-green-600"
															: "text-gray-300"
													}`}
												/>
											)}
											{(display === "pending" || display === "fulfilled") &&
											canToggleParcel ? (
												<button
													type="button"
													onClick={() =>
														onRequestToggleParcel(order, itemIndex, unitIndex)
													}
													className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border touch-manipulation ${
														isParcel
															? "border-amber-400 bg-amber-200 text-amber-900 opacity-100 active:bg-amber-300"
															: "border-amber-200 bg-amber-50 text-amber-800 opacity-50 active:bg-amber-100"
													}`}
													aria-label={`${isParcel ? "Unmark" : "Mark"} ${item.name} for parcel`}
													aria-pressed={isParcel}
												>
													<span className="text-base leading-none" aria-hidden>
														📦
													</span>
												</button>
											) : (display === "pending" || display === "fulfilled") &&
											  isParcel ? (
												<span
													className="inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-full bg-amber-100 text-sm opacity-100"
													aria-label="Parcel"
												>
													📦
												</span>
											) : null}
											{display === "pending" && editable ? (
												<button
													type="button"
													onClick={() =>
														onRequestCancelItem(order, itemIndex, unitIndex)
													}
													className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-700 touch-manipulation active:bg-red-100"
													aria-label={`Cancel ${item.name}`}
												>
													<CrossIcon className="w-5 h-5" />
												</button>
											) : null}
										</span>
									);
									})}
								</span>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function IndividualOrderCard({
	order,
	sessionEditable = true,
	onEdit,
	onKotPrint,
	onRequestMarkDone,
	onRequestCancelItem,
	onRequestToggleParcel,
	onRequestToggleFulfill,
}: {
	order: TOrder;
	sessionEditable?: boolean;
	onEdit: (order: TOrder) => void;
	onKotPrint: (order: TOrder) => void;
	onRequestMarkDone: (order: TOrder) => void;
	onRequestCancelItem: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onRequestToggleParcel: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onRequestToggleFulfill: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
}) {
	const now = useLateClock();
	const isLate = order.kind === "table" && isOrderLate(order, now);
	const lateByMs = isLate ? getOrderLateByMs(order, now) : 0;

	return (
		<div
			className={`rounded-xl shadow-md overflow-hidden ${
				isLate
					? "border-2 border-red-500 bg-red-50"
					: "border bg-white text-card-foreground"
			}`}
		>
			{isLate ? (
				<div className="flex justify-center border-b border-red-200 bg-red-50 px-3 py-2">
					<span
						className="inline-flex items-center rounded-full bg-red-600 px-3 py-0.5 text-xs font-bold text-white shadow-sm whitespace-nowrap"
						aria-label={`Late by ${formatLateDuration(lateByMs)}`}
					>
						Late {formatLateDuration(lateByMs)}
					</span>
				</div>
			) : null}
			<div className="px-4 pt-3 pb-1 border-b border-gray-100">
				<p className="text-sm font-semibold text-gray-900">
					{formatOrderLabel(order)}
				</p>
			</div>
			<div className="p-3">
				<OrderRow
					order={order}
					sessionEditable={sessionEditable}
					onEdit={onEdit}
					onKotPrint={onKotPrint}
					onRequestMarkDone={onRequestMarkDone}
					onRequestCancelItem={onRequestCancelItem}
					onRequestToggleParcel={onRequestToggleParcel}
					onRequestToggleFulfill={onRequestToggleFulfill}
				/>
			</div>
		</div>
	);
}

function TableServicePill({
	label,
	checked,
	loading,
	onClick,
}: {
	label: string;
	checked: boolean;
	loading?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={checked || loading}
			aria-pressed={checked}
			aria-busy={loading}
			className={`inline-flex min-h-[36px] items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold touch-manipulation transition-colors ${
				checked
					? "bg-green-100 border border-green-600 text-green-800"
					: "bg-white border border-gray-300 text-gray-700 active:bg-gray-100"
			}`}
		>
			<span>{label}</span>
			{loading ? (
				<LoadingSpinner className="h-4 w-4 shrink-0" />
			) : checked ? (
				<CheckIcon checked className="w-4 h-4 shrink-0 text-green-700" />
			) : null}
		</button>
	);
}

function GroupNotesModal({
	group,
	draft,
	saving,
	onDraftChange,
	onClose,
	onSave,
}: {
	group: OrderGroup;
	draft: string;
	saving: boolean;
	onDraftChange: (value: string) => void;
	onClose: () => void;
	onSave: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={() => {
				if (!saving) {
					onClose();
				}
			}}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<h2 className="text-lg font-bold">Table notes</h2>
					<p className="text-sm text-gray-600 mt-2">
						Notes for {group.label} — visible on this orders view only.
					</p>
					<textarea
						value={draft}
						onChange={(e) => onDraftChange(e.target.value)}
						placeholder="e.g. birthday, allergy, seating preference..."
						rows={4}
						className="mt-3 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none"
					/>
				</div>
				<ConfirmModalActions
					onCancel={onClose}
					onConfirm={onSave}
					confirmLabel="Save notes"
					confirming={saving}
					cancelDisabled={saving}
				/>
			</div>
		</div>
	);
}

const PAX_QUICK_PICK_OPTIONS = Array.from({ length: 30 }, (_, index) => index + 1);

function GroupPaxModal({
	group,
	draft,
	saving,
	onDraftChange,
	onClose,
	onSave,
}: {
	group: OrderGroup;
	draft: string;
	saving: boolean;
	onDraftChange: (value: string) => void;
	onClose: () => void;
	onSave: () => void;
}) {
	const paxNumber = parseInt(draft.trim(), 10);
	const isValid = !Number.isNaN(paxNumber) && paxNumber >= 1;
	const selectedQuickPick =
		isValid &&
		paxNumber >= 1 &&
		paxNumber <= PAX_QUICK_PICK_OPTIONS.length &&
		String(paxNumber) === draft.trim()
			? paxNumber
			: null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={() => {
				if (!saving) {
					onClose();
				}
			}}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<h2 className="text-lg font-bold">Edit pax</h2>
					<p className="text-sm text-gray-600 mt-2">
						Guest count for {group.label}.
					</p>
					<div className="mt-3 flex items-center gap-3">
						<input
							id="edit-group-pax"
							type="text"
							inputMode="numeric"
							autoFocus
							value={draft}
							onChange={(e) =>
								onDraftChange(e.target.value.replace(/\D/g, "").slice(0, 3))
							}
							placeholder="Guests"
							className="w-20 shrink-0 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center touch-manipulation"
						/>
						<div className="min-w-0 flex-1 overflow-x-auto pb-1">
							<div className="flex gap-2 w-max">
								{PAX_QUICK_PICK_OPTIONS.map((option) => {
									const isSelected = selectedQuickPick === option;
									return (
										<button
											key={option}
											type="button"
											onClick={() => onDraftChange(String(option))}
											aria-pressed={isSelected}
											className={`shrink-0 min-w-[2.5rem] min-h-[2.5rem] rounded-lg border px-3 py-2 text-sm font-semibold touch-manipulation transition-colors ${
												isSelected
													? "border-green-600 bg-green-100 text-green-800"
													: "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
											}`}
										>
											{option}
										</button>
									);
								})}
							</div>
						</div>
					</div>
					{draft.length > 0 && !isValid ? (
						<p className="text-xs text-red-600 mt-2">Enter at least 1 pax.</p>
					) : null}
				</div>
				<ConfirmModalActions
					onCancel={onClose}
					onConfirm={onSave}
					confirmLabel="Save pax"
					confirmDisabled={!isValid}
					confirming={saving}
					cancelDisabled={saving}
				/>
			</div>
		</div>
	);
}

function GroupPhoneModal({
	group,
	draft,
	saving,
	onDraftChange,
	onClose,
	onSave,
}: {
	group: OrderGroup;
	draft: string;
	saving: boolean;
	onDraftChange: (value: string) => void;
	onClose: () => void;
	onSave: () => void;
}) {
	const isValid = draft.length === 0 || isValidCustomerPhone(draft);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={() => {
				if (!saving) {
					onClose();
				}
			}}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<h2 className="text-lg font-bold">Customer phone</h2>
					<p className="text-sm text-gray-600 mt-2">
						Phone for {group.label} (optional).
					</p>
					<div className="mt-4 flex items-center gap-2">
						<span className="text-sm font-semibold text-gray-700">+91</span>
						<input
							id="edit-group-phone"
							type="tel"
							inputMode="numeric"
							autoComplete="tel"
							autoFocus
							maxLength={CUSTOMER_PHONE_DIGITS}
							value={draft}
							onChange={(e) =>
								onDraftChange(
									e.target.value.replace(/\D/g, "").slice(0, CUSTOMER_PHONE_DIGITS)
								)
							}
							placeholder="10-digit phone"
							className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm touch-manipulation"
						/>
					</div>
					{draft.length > 0 && !isValidCustomerPhone(draft) ? (
						<p className="text-xs text-red-600 mt-2">
							Enter exactly {CUSTOMER_PHONE_DIGITS} digits.
						</p>
					) : (
						<p className="text-xs text-gray-500 mt-2">
							Optional — leave blank to clear.
						</p>
					)}
				</div>
				<ConfirmModalActions
					onCancel={onClose}
					onConfirm={onSave}
					confirmLabel={draft ? "Save phone" : "Clear phone"}
					confirmDisabled={!isValid}
					confirming={saving}
					cancelDisabled={saving}
				/>
			</div>
		</div>
	);
}

function TableOrderCard({
	group,
	deviceId,
	isActionPending,
	onBill,
	onEditOrder,
	onKotPrint,
	onRequestMarkDone,
	onRequestWelcomeDrink,
	onRequestComplementary,
	onRequestKidMenu,
	onRequestCancelItem,
	onRequestToggleParcel,
	onRequestToggleFulfill,
	onEditNotes,
	onEditPax,
	onAddPhone,
	onCloseOrder,
	onChangeTable,
	onAcquireLock,
}: {
	group: OrderGroup;
	deviceId: string;
	isActionPending: (key: string) => boolean;
	onBill: (group: OrderGroup) => void;
	onEditOrder: (order: TOrder) => void;
	onKotPrint: (order: TOrder) => void;
	onRequestMarkDone: (order: TOrder) => void;
	onRequestWelcomeDrink: (group: OrderGroup) => void;
	onRequestComplementary: (group: OrderGroup) => void;
	onRequestKidMenu: (group: OrderGroup) => void;
	onRequestCancelItem: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onRequestToggleParcel: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onRequestToggleFulfill: (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => void;
	onEditNotes: (group: OrderGroup) => void;
	onEditPax: (group: OrderGroup) => void;
	onAddPhone: (group: OrderGroup) => void;
	onCloseOrder: (group: OrderGroup) => void;
	onChangeTable: (group: OrderGroup) => void;
	onAcquireLock: (group: OrderGroup) => void;
}) {
	const now = useLateClock();
	const addOrderHref =
		group.kind === "table" && group.tableNumbers?.length
			? buildNewOrderHref({ tables: group.tableNumbers.join(",") })
			: buildNewOrderHref({ type: group.kind, groupKey: group.key });

	const isLate = group.kind === "table" && isGroupLate(group, now);
	const allDone = group.kind === "table" && isGroupFullyMarkedDone(group);
	const lateByMs = isLate ? getGroupLateByMs(group, now) : 0;
	const hasOrdersInGroup = group.orders.length > 0;
	const billingPending = isActionPending(`bill:${group.key}`);
	const drinkPending = isActionPending(`drink:${group.key}`);
	const compPending = isActionPending(`comp:${group.key}`);
	const kidPending = isActionPending(`kid:${group.key}`);
	const drinkServed = isTableWelcomeDrinkServed(group);
	const compServed = isTableComplementaryServed(group);
	const kidServed = isTableKidMenuServed(group);
	const kidEnabled = isTableKidMenuEnabled(group);
	const showTableService = group.kind === "table";
	const groupCustomer = getGroupCustomerDetails(group);
	const showCustomerRow = isCounterOrderKind(group.kind);
	const groupNotes = getGroupNotes(group);
	const groupPax = getGroupPax(group);
	const notesPending = isActionPending(`notes:${group.key}`);
	const paxPending = isActionPending(`pax:${group.key}`);
	const phonePending = isActionPending(`phone:${group.key}`);
	const closePending = isActionPending(`discard:${group.key}`);
	const changeTablePending = isActionPending(`move-table:${group.key}`);
	const acquirePending = isActionPending(`acquire-lock:${group.key}`);
	const sessionLock = getGroupSessionLock(group);
	const sessionEditable = canEditSession(group, deviceId);
	const lockedByOther = isSessionLockedByOther(group, deviceId);
	const [moreOpen, setMoreOpen] = useState(false);
	const [namePopoverOpen, setNamePopoverOpen] = useState(false);

	const statusDots: ReactNode[] = [];
	if (drinkServed) {
		statusDots.push(
			<TableStatusDot key="drink" label="Welcome drink served">
				🥤
			</TableStatusDot>
		);
	}
	if (compServed) {
		statusDots.push(
			<TableStatusDot key="comp" label="Complementary served">
				🫓
			</TableStatusDot>
		);
	}
	if (kidEnabled) {
		statusDots.push(
			<TableStatusDot
				key="kid"
				label={kidServed ? "Kid menu served" : "Kid menu"}
				done={kidServed}
			>
				👶
			</TableStatusDot>
		);
	}

	const paxDot =
		groupPax != null ? (
			<TableStatusDot
				key="pax"
				label={`${groupPax} pax`}
				done={false}
				className="h-7 min-w-[1.75rem] px-1.5 text-xs"
			>
				{groupPax}
			</TableStatusDot>
		) : null;

	return (
		<div className="relative">
			{paxDot ? (
				<div className="absolute -top-2 -left-2 z-0 pointer-events-none">
					{paxDot}
				</div>
			) : null}
			{statusDots.length > 0 ? (
				<div className="absolute -top-2 -right-2 z-0 flex flex-wrap justify-end gap-1 max-w-[60%] pointer-events-none">
					{statusDots}
				</div>
			) : null}
			<div
				className={`rounded-xl shadow-md overflow-hidden ${
					isLate
						? "border-2 border-red-500 bg-red-50"
						: allDone
							? "border-2 border-green-500 bg-green-50"
							: "border bg-white text-card-foreground"
				}`}
			>
			{isLate ? (
				<div className="flex justify-center border-b border-red-200 bg-red-50 px-3 py-1.5">
					<span
						className="inline-flex items-center rounded-full bg-red-600 px-3 py-0.5 text-xs font-bold text-white shadow-sm whitespace-nowrap"
						aria-label={`Late by ${formatLateDuration(lateByMs)}`}
					>
						Late {formatLateDuration(lateByMs)}
					</span>
				</div>
			) : null}
			<div className="flex flex-col space-y-1 p-4 pb-2">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
					<button
						type="button"
						onClick={() => setNamePopoverOpen(true)}
						className="min-w-0 text-left touch-manipulation pt-1"
						aria-label={`Show full name for ${group.label}`}
					>
						<h3 className="text-base font-semibold truncate">{group.label}</h3>
					</button>
					<div className="flex items-center gap-1 shrink-0 flex-nowrap">
						<button
							type="button"
							onClick={() => setMoreOpen(true)}
							className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300 touch-manipulation"
							aria-label={`More actions for ${group.label}`}
						>
							<MoreVerticalIcon className="w-5 h-5" />
						</button>
						{sessionEditable ? (
							<Link
								href={addOrderHref}
								className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-full bg-green-100 text-green-700 hover:bg-green-200 border border-green-300 touch-manipulation"
								aria-label={`Add order to ${group.label}`}
							>
								<PlusIcon className="w-5 h-5 shrink-0" />
							</Link>
						) : (
							<button
								type="button"
								disabled
								className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-full bg-gray-100 text-gray-400 border border-gray-200 touch-manipulation opacity-60"
								aria-label={`Add order locked by ${sessionLock?.deviceName ?? "another device"}`}
								title={
									sessionLock
										? `Locked by ${sessionLock.deviceName}`
										: "Session locked"
								}
							>
								<PlusIcon className="w-5 h-5 shrink-0" />
							</button>
						)}
					</div>
				</div>
				{showCustomerRow ? (
					<div className="flex items-center gap-2 flex-wrap text-sm font-medium text-gray-700">
						{groupCustomer.name ? <span>{groupCustomer.name}</span> : null}
						{groupCustomer.name && groupCustomer.phone ? (
							<span className="text-gray-400">·</span>
						) : null}
						{groupCustomer.phone ? (
							<span className="inline-flex items-center gap-1.5">
								<span>{groupCustomer.phone}</span>
								<a
									href={`tel:${groupCustomer.phone}`}
									className="inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-full bg-green-100 text-green-700 hover:bg-green-200 active:bg-green-300 touch-manipulation"
									aria-label={`Call ${groupCustomer.phone}`}
								>
									<PhoneIcon className="w-3.5 h-3.5 shrink-0" />
								</a>
							</span>
						) : (
							<button
								type="button"
								onClick={() => onAddPhone(group)}
								disabled={phonePending || !sessionEditable}
								className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 active:bg-gray-100 touch-manipulation disabled:opacity-50"
								aria-label="Add phone number"
							>
								<PlusIcon className="w-3.5 h-3.5 shrink-0" />
								phone
							</button>
						)}
					</div>
				) : null}
				{groupNotes ? (
					<p className="text-xs text-gray-600 leading-relaxed">
						<span className="font-semibold text-gray-700">Note:</span>{" "}
						{groupNotes}
					</p>
				) : null}
				<p className="text-xs text-gray-500">
					{group.orders.length} order{group.orders.length === 1 ? "" : "s"}
				</p>
				{lockedByOther && sessionLock ? (
					<p className="text-xs font-semibold text-amber-800">
						Locked by {sessionLock.deviceName}
					</p>
				) : null}
			</div>
			<div className="px-4 pb-4 pt-0 space-y-2">
				{group.orders.map((order) => (
					<OrderRow
						key={order.id}
						order={order}
						sessionEditable={sessionEditable}
						onEdit={onEditOrder}
						onKotPrint={onKotPrint}
						onRequestMarkDone={onRequestMarkDone}
						onRequestCancelItem={onRequestCancelItem}
						onRequestToggleParcel={onRequestToggleParcel}
						onRequestToggleFulfill={onRequestToggleFulfill}
					/>
				))}
			</div>
			</div>
			{namePopoverOpen ? (
				<TableNamePopover
					label={group.label}
					onClose={() => setNamePopoverOpen(false)}
				/>
			) : null}
			{moreOpen ? (
				<TableGroupMoreSheet
					group={group}
					hasOrdersInGroup={hasOrdersInGroup}
					groupPax={groupPax}
					groupNotes={groupNotes}
					showTableService={showTableService}
					drinkServed={drinkServed}
					compServed={compServed}
					kidEnabled={kidEnabled}
					kidServed={kidServed}
					billingPending={billingPending}
					changeTablePending={changeTablePending}
					drinkPending={drinkPending}
					compPending={compPending}
					kidPending={kidPending}
					notesPending={notesPending}
					paxPending={paxPending}
					closePending={closePending}
					sessionEditable={sessionEditable}
					lockHolderName={sessionLock?.deviceName ?? null}
					acquirePending={acquirePending}
					onAcquireLock={onAcquireLock}
					onBill={onBill}
					onChangeTable={onChangeTable}
					onEditNotes={onEditNotes}
					onEditPax={onEditPax}
					onCloseOrder={onCloseOrder}
					onRequestWelcomeDrink={onRequestWelcomeDrink}
					onRequestComplementary={onRequestComplementary}
					onRequestKidMenu={onRequestKidMenu}
					onClose={() => setMoreOpen(false)}
				/>
			) : null}
		</div>
	);
}

function ChangeTableSheetModal({
	group,
	selectedTables,
	occupiedTables,
	onToggleTable,
	onContinue,
	onClose,
}: {
	group: OrderGroup;
	selectedTables: number[];
	occupiedTables: Set<number>;
	onToggleTable: (tableNumber: number) => void;
	onContinue: () => void;
	onClose: () => void;
}) {
	const currentTables = group.tableNumbers ?? [];
	const canContinue =
		selectedTables.length > 0 &&
		!tableNumbersEqual(selectedTables, currentTables);

	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-0"
			onClick={onClose}
		>
			<div
				className="w-full max-w-md rounded-t-xl bg-white shadow-xl max-h-[85vh] flex flex-col pb-[env(safe-area-inset-bottom)]"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-lg font-bold">Change table</h2>
						<button
							type="button"
							onClick={onClose}
							className="text-sm font-semibold text-gray-500 hover:text-black touch-manipulation"
						>
							Close
						</button>
					</div>
					<p className="text-sm text-gray-600 mt-2">
						Select available table(s) for {group.label}. Tap to toggle seats.
					</p>
				</div>
				<div className="overflow-y-auto flex-1 px-5 py-4">
					<div className="grid grid-cols-5 gap-2">
						{Array.from({ length: TABLE_COUNT }, (_, index) => index + 1).map(
							(tableNumber) => {
								const isSelected = selectedTables.includes(tableNumber);
								const isDisabled = !isTableAvailableForGroupMove(
									tableNumber,
									group,
									occupiedTables
								);

								return (
									<button
										key={tableNumber}
										type="button"
										disabled={isDisabled}
										onClick={() => onToggleTable(tableNumber)}
										aria-label={
											isDisabled
												? `Table ${tableNumber} occupied`
												: `Table ${tableNumber}`
										}
										className={`relative py-2 rounded-lg text-sm font-bold transition-colors touch-manipulation ${
											isDisabled
												? "bg-gray-200 text-gray-400 cursor-not-allowed"
												: isSelected
													? "bg-green-500 text-white"
													: "bg-gray-100 text-gray-800 hover:bg-gray-200"
										}`}
									>
										{tableNumber}
										{isDisabled ? (
											<span className="absolute -top-1 -right-1 flex h-[1.1rem] w-[1.1rem] items-center justify-center rounded-full bg-amber-500 text-white text-[10px] leading-none shadow-sm">
												🪑
											</span>
										) : null}
									</button>
								);
							}
						)}
					</div>
					{selectedTables.length > 0 ? (
						<p className="text-sm font-medium text-gray-700 mt-4">
							Selected: {formatTableGroupLabel(selectedTables)}
							{tableNumbersEqual(selectedTables, currentTables) ? (
								<span className="text-gray-500 font-normal">
									{" "}
									(same as current)
								</span>
							) : null}
						</p>
					) : (
						<p className="text-sm text-red-600 mt-4">
							Select at least one table.
						</p>
					)}
				</div>
				<div className="border-t px-5 py-4">
					<TouchActionButton
						onClick={onContinue}
						disabled={!canContinue}
						className="w-full bg-green-500 border border-green-600 text-white active:bg-green-600 disabled:opacity-40"
					>
						Continue
					</TouchActionButton>
				</div>
			</div>
		</div>
	);
}

function WaterBottlesModal({
	groupLabel,
	values,
	onChange,
	onConfirm,
	onCancel,
	confirming,
}: {
	groupLabel: string;
	values: Record<WaterDishName, string>;
	onChange: (dishName: WaterDishName, value: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
	confirming?: boolean;
}) {
	const [visibleViewport, setVisibleViewport] = useState<{
		top: number;
		height: number;
	} | null>(null);

	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) {
			return;
		}

		const updateVisibleViewport = () => {
			setVisibleViewport({
				top: viewport.offsetTop,
				height: viewport.height,
			});
		};

		updateVisibleViewport();
		viewport.addEventListener("resize", updateVisibleViewport);
		viewport.addEventListener("scroll", updateVisibleViewport);
		return () => {
			viewport.removeEventListener("resize", updateVisibleViewport);
			viewport.removeEventListener("scroll", updateVisibleViewport);
		};
	}, []);

	return (
		<div
			className="fixed left-0 right-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 px-4 py-4 transition-[top,height] duration-150"
			style={
				visibleViewport
					? {
							top: `${visibleViewport.top}px`,
							height: `${visibleViewport.height}px`,
						}
					: { top: 0, bottom: 0 }
			}
			onClick={() => {
				if (!confirming) {
					onCancel();
				}
			}}
		>
			<div
				className="max-h-full w-full max-w-sm overflow-y-auto rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<h2 className="text-lg font-bold">Water bottles</h2>
					<p className="text-sm text-gray-600 mt-2">
						How many water bottles for {groupLabel}?
					</p>
					<div className="mt-4 space-y-4">
						{WATER_DISH_NAMES.map((dishName) => {
							const parsedCount = parseInt(values[dishName].trim(), 10);
							const count = Number.isNaN(parsedCount) ? 0 : parsedCount;
							const inputId = `water-bottle-count-${dishName.replace(/\s+/g, "-")}`;
							return (
								<div key={dishName}>
									<label
										htmlFor={inputId}
										className="block text-sm font-medium text-gray-800"
									>
										{dishName}
									</label>
									<div className="mt-2 flex items-center justify-center gap-3">
										<button
											type="button"
											onClick={() =>
												onChange(dishName, String(Math.max(0, count - 1)))
											}
											disabled={confirming || count <= 0}
											className="w-10 h-10 flex items-center justify-center rounded-full bg-red-100 text-red-700 text-xl leading-none touch-manipulation disabled:opacity-40"
											aria-label={`Decrease ${dishName}`}
										>
											-
										</button>
										<input
											id={inputId}
											type="text"
											inputMode="numeric"
											value={values[dishName]}
											disabled={confirming}
											onChange={(event) =>
												onChange(
													dishName,
													event.target.value.replace(/\D/g, "").slice(0, 3)
												)
											}
											className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center touch-manipulation disabled:opacity-60"
										/>
										<button
											type="button"
											onClick={() =>
												onChange(dishName, String(Math.min(999, count + 1)))
											}
											disabled={confirming || count >= 999}
											className="w-10 h-10 flex items-center justify-center rounded-full bg-green-100 text-green-700 text-xl leading-none touch-manipulation disabled:opacity-40"
											aria-label={`Increase ${dishName}`}
										>
											+
										</button>
									</div>
								</div>
							);
						})}
					</div>
					<p className="text-xs text-gray-500 mt-3">
						Adjust if needed before billing.
					</p>
				</div>
				<ConfirmModalActions
					onCancel={onCancel}
					onConfirm={onConfirm}
					confirmLabel="Continue to bill"
					confirming={confirming}
					cancelDisabled={confirming}
				/>
			</div>
		</div>
	);
}

function ConfirmOrderActionModal({
	title,
	message,
	confirmLabel,
	cancelLabel,
	confirming,
	destructive,
	onConfirm,
	onCancel,
}: {
	title: string;
	message: string;
	confirmLabel: string;
	cancelLabel?: string;
	confirming?: boolean;
	destructive?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={() => {
				if (!confirming) {
					onCancel();
				}
			}}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div
					className={`px-5 py-4 border-b ${
						destructive ? "bg-red-50 border-red-200" : ""
					}`}
				>
					<h2
						className={`text-lg font-bold ${
							destructive ? "text-red-700" : ""
						}`}
					>
						{title}
					</h2>
					<p
						className={`text-sm mt-2 ${
							destructive ? "text-red-800" : "text-gray-600"
						}`}
					>
						{message}
					</p>
				</div>
				<div className="flex gap-2 p-4">
					<button
						type="button"
						onClick={onCancel}
						disabled={confirming}
						className="flex-1 min-h-[44px] rounded-lg bg-gray-100 border border-gray-300 text-sm font-semibold touch-manipulation active:bg-gray-200 disabled:opacity-60"
					>
						{cancelLabel ?? "Cancel"}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={confirming}
						aria-busy={confirming}
						className={`flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg text-white text-sm font-semibold touch-manipulation disabled:opacity-60 ${
							destructive
								? "bg-red-600 active:bg-red-700"
								: "bg-green-500 active:bg-green-600"
						}`}
					>
						{confirming ? (
							<LoadingSpinner className="h-4 w-4 text-white" />
						) : (
							confirmLabel
						)}
					</button>
				</div>
			</div>
		</div>
	);
}

function DayOpenWarningModal({
	onProceed,
	onGoToChecklist,
	onClose,
}: {
	onProceed: () => void;
	onGoToChecklist: () => void;
	onClose: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={onClose}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white shadow-xl overflow-hidden"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="bg-red-50 border-b border-red-200 px-5 py-4">
					<div className="flex items-start gap-3">
						<span
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 text-lg font-bold"
							aria-hidden
						>
							!
						</span>
						<div className="min-w-0">
							<h2 className="text-lg font-bold text-red-700">
								Day open not done
							</h2>
							<p className="text-sm text-red-600/90 mt-1">
								Please complete the day open checklist before taking orders.
							</p>
						</div>
					</div>
				</div>
				<div className="p-4 space-y-2">
					<button
						type="button"
						onClick={onProceed}
						className="w-full min-h-[48px] inline-flex items-center justify-center rounded-lg bg-red-600 text-white text-sm font-bold touch-manipulation active:bg-red-700"
					>
						Take order anyway
					</button>
					<button
						type="button"
						onClick={onGoToChecklist}
						className="w-full min-h-[48px] inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 text-sm font-semibold touch-manipulation active:bg-gray-100"
					>
						Open day open checklist
					</button>
					<button
						type="button"
						onClick={onClose}
						className="w-full min-h-[40px] inline-flex items-center justify-center text-gray-500 text-sm font-medium touch-manipulation"
					>
						Dismiss
					</button>
				</div>
			</div>
		</div>
	);
}

function ConfirmItemModal({
	dishName,
	unit,
	isUncheck,
	confirming,
	onConfirm,
	onCancel,
}: {
	dishName: string;
	unit: ItemGroup["units"][number];
	isUncheck: boolean;
	confirming?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={() => {
				if (!confirming) {
					onCancel();
				}
			}}
		>
			<div
				className="w-full max-w-sm rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="px-5 py-4 border-b">
					<h2 className="text-lg font-bold">
						{isUncheck ? "Mark as pending?" : "Mark as ready?"}
					</h2>
					<p className="text-sm text-gray-600 mt-2">
						{isUncheck ? "Undo ready for" : "Confirm ready for"}{" "}
						<QtyBadge qty={1} />
						<span className="font-semibold">{dishName}</span>
						<br />
						<span className="text-gray-500">
							{formatOrderTime(unit.createdAt)}
						</span>
					</p>
				</div>
				<ConfirmModalActions
					onCancel={onCancel}
					onConfirm={onConfirm}
					confirmLabel="Confirm"
					confirming={confirming}
					cancelDisabled={confirming}
				/>
			</div>
		</div>
	);
}

function ItemGroupCard({
	group,
	orders,
	onToggleUnit,
	onRequestCancelUnit,
	aggregatesView,
}: {
	group: ItemGroup;
	orders: TOrder[];
	onToggleUnit: (dishName: string, wasFulfilled: boolean) => Promise<void>;
	onRequestCancelUnit: (unit: ItemGroup["units"][number]) => void;
	aggregatesView: boolean;
}) {
	const [pendingAction, setPendingAction] = useState<{
		unitIndex: number;
		wasFulfilled: boolean;
	} | null>(null);
	const [confirmingToggle, setConfirmingToggle] = useState(false);
	const toggleLock = useInFlightLock();

	const pendingUnit =
		pendingAction != null ? group.units[pendingAction.unitIndex] : null;

	const dishAggregates = useMemo(() => {
		const map = new Map<
			string,
			{
				totalQty: number;
				pendingQty: number;
				fulfilledQty: number;
				cancelledQty: number;
				tables: string[];
			}
		>();
		for (const unit of group.units) {
			const entry = map.get(unit.dishName) ?? {
				totalQty: 0,
				pendingQty: 0,
				fulfilledQty: 0,
				cancelledQty: 0,
				tables: [],
			};
			entry.totalQty += 1;
			if (unit.cancelled) {
				entry.cancelledQty += 1;
			} else if (unit.fulfilled) {
				entry.fulfilledQty += 1;
			} else {
				entry.pendingQty += 1;
			}
			if (!unit.cancelled && !entry.tables.includes(unit.orderLabel)) {
				entry.tables.push(unit.orderLabel);
			}
			map.set(unit.dishName, entry);
		}
		return Array.from(map.entries())
			.map(([dishName, counts]) => ({ dishName, ...counts }))
			.sort((a, b) => a.dishName.localeCompare(b.dishName));
	}, [group.units]);

	return (
		<div className="rounded-xl border bg-white shadow-md">
			<div className="p-6 pb-3">
				<h3 className="text-lg font-semibold">{group.name}</h3>
				<p className="text-xs text-gray-500 mt-1">
					{aggregatesView
						? `${dishAggregates.length} dish${dishAggregates.length === 1 ? "" : "es"} · ${group.totalQty} total`
						: `${group.remainingQty} of ${group.totalQty} pending`}
				</p>
			</div>
			{aggregatesView ? (
				<ul className="px-4 pb-6 space-y-1">
					{dishAggregates.map(
						({
							dishName,
							totalQty,
							pendingQty,
							fulfilledQty,
							cancelledQty,
							tables,
						}) => (
							<li
								key={dishName}
								className="flex items-start gap-3 min-h-[52px] px-2 py-1.5 rounded-lg"
							>
								<QtyBadge qty={totalQty} />
								<div className="min-w-0 flex-1">
									<p className="text-base font-medium leading-snug">
										{dishName}
									</p>
									{tables.length > 0 ? (
										<div className="flex flex-wrap gap-1 mt-1">
											{tables.map((table) => (
												<span
													key={table}
													className="inline-flex items-center rounded-full bg-blue-50 border border-blue-200 px-1.5 text-xs font-semibold text-blue-700"
												>
													{table}
												</span>
											))}
										</div>
									) : null}
								</div>
								<div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
									{pendingQty > 0 ? (
										<span className="text-xs font-medium text-amber-700">
											{pendingQty} pending
										</span>
									) : null}
									{fulfilledQty > 0 ? (
										<span className="text-xs font-medium text-green-700">
											{fulfilledQty} ready
										</span>
									) : null}
									{cancelledQty > 0 ? (
										<span className="text-xs font-medium text-red-600">
											{cancelledQty} cancelled
										</span>
									) : null}
								</div>
							</li>
						)
					)}
				</ul>
			) : (
			<ul className="px-4 pb-6 space-y-1">
				{group.units.map((unit, index) => {
					const canCheck = isUnitNextToFulfill(orders, unit);
					const canUncheck = isUnitLastFulfilled(orders, unit);
					const canCancel = isUnitPending(unit);
					const interactive = canCheck || canUncheck;
					const rowPending =
						confirmingToggle &&
						pendingUnit != null &&
						pendingUnit.orderId === unit.orderId &&
						pendingUnit.itemIndex === unit.itemIndex &&
						pendingUnit.unitIndex === unit.unitIndex;

					return (
						<li
							key={`${unit.orderId}-${unit.itemIndex}-${unit.unitIndex}`}
							className={`flex items-center gap-2 text-sm min-h-[52px] px-2 rounded-lg ${
								unit.cancelled ? "bg-red-50/70" : ""
							}`}
						>
							<button
								type="button"
								disabled={(!interactive && !rowPending) || unit.cancelled}
								onClick={() => {
									if (canCheck) {
										setPendingAction({ unitIndex: index, wasFulfilled: false });
									} else if (canUncheck) {
										setPendingAction({ unitIndex: index, wasFulfilled: true });
									}
								}}
								className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg touch-manipulation ${
									interactive || rowPending
										? "active:bg-gray-100"
										: "opacity-50"
								}`}
								aria-label={
									unit.cancelled
										? `${unit.dishName} cancelled`
										: unit.fulfilled
											? `Mark ${unit.dishName} as pending`
											: `Mark ${unit.dishName} as ready`
								}
								aria-busy={rowPending}
							>
								{rowPending ? (
									<LoadingSpinner className="h-6 w-6 text-gray-700" />
								) : unit.cancelled ? (
									<CrossIcon className="h-7 w-7 text-red-500" />
								) : (
									<CheckIcon
										checked={unit.fulfilled}
										className={`h-7 w-7 ${
											unit.fulfilled ? "text-green-600" : "text-gray-300"
										}`}
									/>
								)}
							</button>
							<div className="min-w-0 flex-1 py-2">
								<p
									className={`text-base font-medium truncate leading-snug ${
										unit.cancelled ? "line-through text-gray-400" : ""
									}`}
								>
									{unit.dishName}
								</p>
								<p className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5 flex-wrap">
									<span className="inline-flex items-center rounded-full bg-blue-50 border border-blue-200 px-1.5 font-semibold text-blue-700">
										{unit.orderLabel}
									</span>
									<span>{formatOrderTime(unit.createdAt)}</span>
									<QtyBadge qty={1} />
									{unit.cancelled && unit.cancelReason ? (
										<span className="text-red-600 font-medium">
											{itemCancelReasonLabel(unit.cancelReason)}
										</span>
									) : null}
								</p>
							</div>
							{canCancel ? (
								<button
									type="button"
									onClick={() => onRequestCancelUnit(unit)}
									className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-700 touch-manipulation active:bg-red-100"
									aria-label={`Cancel ${unit.dishName}`}
								>
									<CrossIcon className="w-5 h-5" />
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
			)}

			{!aggregatesView && pendingAction && pendingUnit && (
				<ConfirmItemModal
					dishName={pendingUnit.dishName}
					unit={pendingUnit}
					isUncheck={pendingAction.wasFulfilled}
					confirming={confirmingToggle}
					onCancel={() => {
						if (!confirmingToggle) {
							setPendingAction(null);
						}
					}}
					onConfirm={() => {
						void (async () => {
							if (!toggleLock.tryLock()) {
								return;
							}
							setConfirmingToggle(true);
							try {
								await onToggleUnit(
									pendingUnit.dishName,
									pendingAction.wasFulfilled
								);
								setPendingAction(null);
							} finally {
								setConfirmingToggle(false);
								toggleLock.unlock();
							}
						})();
					}}
				/>
			)}
		</div>
	);
}

function ReadyOrdersModal({
	orders,
	onClose,
}: {
	orders: TOrder[];
	onClose: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={onClose}
		>
			<div
				className="w-full max-w-md rounded-xl bg-white shadow-xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b px-5 py-4">
					<h2 className="text-lg font-bold">Ready orders</h2>
					<button
						type="button"
						onClick={onClose}
						className="text-gray-500 hover:text-black text-xl leading-none"
						aria-label="Close"
					>
						×
					</button>
				</div>
				<ul className="max-h-80 overflow-y-auto divide-y">
					{orders.map((order) => (
						<li key={order.id} className="px-5 py-3">
							<p className="font-semibold">
								{order.orderNumber != null
									? `${formatDailyOrderNumber(order.orderNumber)} · ${formatOrderLabel(order)}`
									: formatOrderLabel(order)}
							</p>
							<p className="text-xs text-gray-500 mt-0.5">
								{formatOrderTime(order.createdAt)}
							</p>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

type ChecklistProgress = { done: number; total: number };

function ChecklistProgressCard({
	title,
	href,
	progress,
}: {
	title: string;
	href: string;
	progress: ChecklistProgress;
}) {
	const total = progress.total;
	const done = Math.min(progress.done, total);
	const remaining = Math.max(total - done, 0);
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	const allDone = total > 0 && remaining === 0;

	return (
		<Link
			href={href}
			className="block rounded-xl bg-white border border-gray-200/80 shadow-md p-3 touch-manipulation active:bg-gray-50"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-bold text-gray-800 truncate">
					{title}
				</span>
				<span
					className={`text-xs font-bold shrink-0 ${
						allDone ? "text-green-600" : "text-gray-500"
					}`}
				>
					{done}/{total}
				</span>
			</div>
			<div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-red-400">
				<div
					className="h-full rounded-full bg-green-500 transition-all"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<div className="mt-1.5 flex items-center justify-between">
				<span className="text-[10px] font-medium text-gray-500">
					{pct}% done
				</span>
				{remaining > 0 ? (
					<span className="text-[10px] font-semibold text-red-500">
						{remaining} left
					</span>
				) : (
					<span className="text-[10px] font-semibold text-green-600">
						Complete
					</span>
				)}
			</div>
		</Link>
	);
}

export default function OrderPage() {
	const router = useRouter();
	const pathname = usePathname();
	const { deviceId, deviceName } = useOrderOpsSync();
	const [orders, setOrders] = useState<TOrder[]>([]);
	const [groups, setGroups] = useState<OrderGroup[]>([]);
	const [itemGroups, setItemGroups] = useState<ItemGroup[]>([]);
	const [loading, setLoading] = useState(true);
	const [activeTab, setActiveTab] = useState<TabId>("tables");
	const [tableOrdersView, setTableOrdersView] = useState<TableOrdersView>("groups");
	const [selectedTableFilters, setSelectedTableFilters] = useState<number[]>([]);
	const [itemsAggregatesView, setItemsAggregatesView] = useState(false);
	const [viewFiltersOpen, setViewFiltersOpen] = useState(false);
	const [readyModalOpen, setReadyModalOpen] = useState(false);
	const [showDayOpenWarning, setShowDayOpenWarning] = useState(false);
	const [editingOrder, setEditingOrder] = useState<TOrder | null>(null);
	const [pendingMarkDone, setPendingMarkDone] = useState<TOrder | null>(null);
	const [pendingWelcomeDrink, setPendingWelcomeDrink] =
		useState<OrderGroup | null>(null);
	const [pendingComplementary, setPendingComplementary] =
		useState<OrderGroup | null>(null);
	const [pendingKidMenu, setPendingKidMenu] = useState<OrderGroup | null>(null);
	const [pendingBillGroup, setPendingBillGroup] = useState<OrderGroup | null>(
		null
	);
	const [waterBottleDraft, setWaterBottleDraft] = useState(
		emptyWaterBottleDrafts
	);
	const [changeTableGroup, setChangeTableGroup] = useState<OrderGroup | null>(
		null
	);
	const [changeTableDraft, setChangeTableDraft] = useState<number[]>([]);
	const [pendingChangeTableConfirm, setPendingChangeTableConfirm] = useState<{
		group: OrderGroup;
		newTables: number[];
	} | null>(null);
	const [pendingCloseTable, setPendingCloseTable] = useState<OrderGroup | null>(
		null
	);
	const [pendingDiscardGroup, setPendingDiscardGroup] =
		useState<OrderGroup | null>(null);
	const [pendingAcquireLock, setPendingAcquireLock] =
		useState<OrderGroup | null>(null);
	const [editingNotesGroup, setEditingNotesGroup] = useState<OrderGroup | null>(
		null
	);
	const [notesDraft, setNotesDraft] = useState("");
	const [editingPaxGroup, setEditingPaxGroup] = useState<OrderGroup | null>(
		null
	);
	const [paxDraft, setPaxDraft] = useState("");
	const [editingPhoneGroup, setEditingPhoneGroup] = useState<OrderGroup | null>(
		null
	);
	const [phoneDraft, setPhoneDraft] = useState("");
	const [pendingCancelItem, setPendingCancelItem] = useState<{
		orderId: string;
		itemIndex: number;
		unitIndex: number;
		dishName: string;
	} | null>(null);
	const [pendingParcelItem, setPendingParcelItem] = useState<{
		orderId: string;
		itemIndex: number;
		unitIndex: number;
		dishName: string;
		isParcel: boolean;
	} | null>(null);
	const [pendingFulfillItem, setPendingFulfillItem] = useState<{
		orderId: string;
		itemIndex: number;
		unitIndex: number;
		dishName: string;
		isFulfilled: boolean;
	} | null>(null);
	const [pendingActions, setPendingActions] = useState<Record<string, boolean>>(
		{}
	);
	const [confirmingAction, setConfirmingAction] = useState<string | null>(null);
	const [checklistProgress, setChecklistProgress] = useState<{
		open: ChecklistProgress;
		close: ChecklistProgress;
	}>(() => ({
		open: { done: 0, total: getAllDayChecklistItemIds("open").length },
		close: { done: 0, total: getAllDayChecklistItemIds("close").length },
	}));
	const [dishCategoryMap, setDishCategoryMap] = useState<Record<string, string>>(
		{}
	);
	const dishCategoryMapRef = useRef(dishCategoryMap);
	dishCategoryMapRef.current = dishCategoryMap;
	const ordersRef = useRef(orders);
	ordersRef.current = orders;
	const hasLoadedOnceRef = useRef(false);
	const inFlightActionsRef = useRef(new Set<string>());

	const readyOrders = useMemo(() => getReadyOrders(orders), [orders]);

	const occupiedTables = useMemo(
		() => getOccupiedTableNumbers(orders),
		[orders]
	);

	const activeTableNumbers = useMemo(
		() => Array.from(occupiedTables).sort((a, b) => a - b),
		[occupiedTables]
	);

	const selectedTableFilterSet = useMemo(
		() => new Set(selectedTableFilters),
		[selectedTableFilters]
	);

	const filteredGroups = useMemo(() => {
		if (selectedTableFilterSet.size === 0) {
			return groups;
		}
		return groups.filter((group) =>
			groupMatchesTableFilter(group, selectedTableFilterSet)
		);
	}, [groups, selectedTableFilterSet]);

	const filteredItemGroups = useMemo(() => {
		if (selectedTableFilterSet.size === 0) {
			return itemGroups;
		}
		return itemGroups
			.map((group) =>
				filterItemGroupByTables(group, orders, selectedTableFilterSet)
			)
			.filter((group): group is ItemGroup => group != null);
	}, [itemGroups, orders, selectedTableFilterSet]);

	const chronologicalOrders = useMemo(
		() =>
			filteredGroups
				.flatMap((group) => group.orders)
				.sort((a, b) => a.createdAt - b.createdAt),
		[filteredGroups]
	);

	const toggleTableFilter = useCallback((tableNumber: number) => {
		setSelectedTableFilters((current) =>
			current.includes(tableNumber)
				? current.filter((value) => value !== tableNumber)
				: [...current, tableNumber].sort((a, b) => a - b)
		);
	}, []);

	const clearTableFilters = useCallback(() => {
		setSelectedTableFilters([]);
	}, []);

	const isActionPending = useCallback(
		(key: string) =>
			Boolean(pendingActions[key]) || confirmingAction === key,
		[pendingActions, confirmingAction]
	);

	const runPendingAction = useCallback(
		async (key: string, action: () => Promise<void>) => {
			if (inFlightActionsRef.current.has(key)) {
				return;
			}
			inFlightActionsRef.current.add(key);
			setPendingActions((current) => ({ ...current, [key]: true }));
			try {
				await action();
			} finally {
				inFlightActionsRef.current.delete(key);
				setPendingActions((current) => {
					const next = { ...current };
					delete next[key];
					return next;
				});
			}
		},
		[]
	);

	const runConfirmingAction = useCallback(
		async (key: string, action: () => Promise<void>) => {
			if (inFlightActionsRef.current.has(key)) {
				return;
			}
			inFlightActionsRef.current.add(key);
			setConfirmingAction(key);
			try {
				await action();
			} finally {
				inFlightActionsRef.current.delete(key);
				setConfirmingAction(null);
			}
		},
		[]
	);

	const applyOrderState = useCallback(
		(nextOrders: TOrder[], categoryMap?: Record<string, string>) => {
			const map = categoryMap ?? dishCategoryMapRef.current;
			setOrders(nextOrders);
			setGroups(groupOrdersByTable(nextOrders));
			setItemGroups(groupItemsByKitchenGroup(nextOrders, map));
			if (categoryMap) {
				setDishCategoryMap(categoryMap);
			}
		},
		[]
	);

	const loadChecklistProgress = useCallback(async () => {
		const today = getTodayDateKey();
		const computeProgress = async (
			kind: DayChecklistKind
		): Promise<ChecklistProgress> => {
			const itemIds = getAllDayChecklistItemIds(kind);
			const state = await getDayChecklistForDate(today, kind);
			const done = itemIds.filter((id) => state[id] === true).length;
			return { done, total: itemIds.length };
		};

		try {
			const [open, close] = await Promise.all([
				computeProgress("open"),
				computeProgress("close"),
			]);
			setChecklistProgress({ open, close });
		} catch (error) {
			console.error("Failed to load checklist progress:", error);
		}
	}, []);

	const loadOrders = useCallback((options?: { background?: boolean }) => {
		if (!options?.background && !hasLoadedOnceRef.current) {
			setLoading(true);
		}

		const loadMenu = options?.background
			? getMenuItemsPreferCache()
			: getMenuItemsPreferCache({ refresh: true });

		Promise.all([
			localforage.getItem<TOrdersStore>(ORDERS_KEY),
			Object.keys(dishCategoryMapRef.current).length > 0 && options?.background
				? Promise.resolve(null)
				: loadMenu,
		])
			.then(async ([store, menuItems]) => {
				const rawOrders = store?.orders ?? [];
				const categoryMap = menuItems
					? buildDishCategoryMap(menuItems)
					: dishCategoryMapRef.current;
				const maintained = maintainOrders(rawOrders, Date.now());
				applyOrderState(maintained, menuItems ? categoryMap : undefined);
				if (ordersStoreChanged(rawOrders, maintained)) {
					const { canPublishOrderOps } = await import(
						"@/src/utils/sync_write_gate"
					);
					if (canPublishOrderOps()) {
						await updateOrders(maintained);
					}
				}
			})
			.catch((error) => {
				console.error("Failed to load orders:", error);
				if (!hasLoadedOnceRef.current) {
					setOrders([]);
					setGroups([]);
					setItemGroups([]);
				}
			})
			.finally(() => {
				setLoading(false);
				hasLoadedOnceRef.current = true;
			});
	}, [applyOrderState]);

	useEffect(() => {
		if (pathname !== "/order") {
			return;
		}

		loadOrders();
		void loadChecklistProgress();

		const onFocus = () => {
			loadOrders({ background: true });
			void loadChecklistProgress();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [pathname, loadOrders, loadChecklistProgress]);

	useEffect(() => {
		const onOrderOpsUpdated = (event: Event) => {
			const domain = (event as CustomEvent<OrderOpsUpdatedDetail>).detail
				?.domain;
			if (!domain || domain === "all" || domain === "orders") {
				loadOrders({ background: true });
			}
			if (!domain || domain === "all" || domain === "dayChecklists") {
				void loadChecklistProgress();
			}
		};
		window.addEventListener(ORDER_OPS_EVENT, onOrderOpsUpdated);
		return () => window.removeEventListener(ORDER_OPS_EVENT, onOrderOpsUpdated);
	}, [loadOrders, loadChecklistProgress]);

	useEffect(() => {
		const interval = window.setInterval(() => {
			const current = ordersRef.current;
			if (current.length === 0) {
				return;
			}
			const maintained = maintainOrders(current, Date.now());
			if (!ordersStoreChanged(current, maintained)) {
				return;
			}
			void (async () => {
				const { canPublishOrderOps } = await import(
					"@/src/utils/sync_write_gate"
				);
				if (!canPublishOrderOps()) {
					return;
				}
				const saved = await updateOrders(maintained, Date.now());
				applyOrderState(saved);
			})();
		}, 15_000);
		return () => window.clearInterval(interval);
	}, [applyOrderState]);

	useEffect(() => {
		if (readyOrders.length === 0) {
			setReadyModalOpen(false);
		}
	}, [readyOrders.length]);

	const persistOrders = async (nextOrders: TOrder[]) => {
		const maintained = await updateOrders(nextOrders, Date.now());
		applyOrderState(maintained);
	};

	const alertSessionLocked = (group: OrderGroup) => {
		const lock = getGroupSessionLock(group);
		alert(
			lock
				? `Locked by ${lock.deviceName}. Open ⋮ and acquire the lock to edit.`
				: "This session is locked on another device."
		);
	};

	const persistGroupEdit = async (group: OrderGroup, nextOrders: TOrder[]) => {
		const latest =
			groups.find((entry) => entry.key === group.key) ??
			findOrderGroupByKey(nextOrders, group.key) ??
			group;
		if (!canEditSession(latest, deviceId)) {
			alertSessionLocked(latest);
			return;
		}
		await persistOrders(
			claimGroupSessionLock(nextOrders, latest, deviceId, deviceName)
		);
	};

	const persistOrderEdit = async (orderId: string, nextOrders: TOrder[]) => {
		const group = findOrderGroupForOrder(nextOrders, orderId);
		if (group) {
			await persistGroupEdit(group, nextOrders);
			return;
		}
		await persistOrders(
			claimSessionLockForOrder(nextOrders, orderId, deviceId, deviceName)
		);
	};

	const handleToggleDishUnit = async (
		dishName: string,
		wasFulfilled: boolean
	) => {
		const nextOrders = wasFulfilled
			? unfulfillLastUnitForDish(orders, dishName)
			: fulfillNextUnitForDish(orders, dishName);
		// Kitchen aggregate toggles may touch multiple sessions — claim per affected order.
		let claimed = nextOrders;
		const touchedIds = new Set<string>();
		for (const before of orders) {
			const after = nextOrders.find((entry) => entry.id === before.id);
			if (!after) continue;
			if (JSON.stringify(before.items) !== JSON.stringify(after.items)) {
				touchedIds.add(before.id);
			}
		}
		for (const orderId of Array.from(touchedIds)) {
			const group = findOrderGroupForOrder(claimed, orderId);
			if (group && !canEditSession(group, deviceId)) {
				alertSessionLocked(group);
				return;
			}
		}
		for (const orderId of Array.from(touchedIds)) {
			claimed = claimSessionLockForOrder(
				claimed,
				orderId,
				deviceId,
				deviceName
			);
		}
		await persistOrders(claimed);
	};

	const handleRequestCancelItem = (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => {
		const item = order.items[itemIndex];
		if (!item || !isOrderEditable(order)) {
			return;
		}
		setPendingCancelItem({
			orderId: order.id,
			itemIndex,
			unitIndex,
			dishName: item.name,
		});
	};

	const handleRequestCancelUnit = (unit: ItemGroup["units"][number]) => {
		const order = orders.find((entry) => entry.id === unit.orderId);
		if (!order || !isOrderEditable(order)) {
			return;
		}
		setPendingCancelItem({
			orderId: unit.orderId,
			itemIndex: unit.itemIndex,
			unitIndex: unit.unitIndex,
			dishName: unit.dishName,
		});
	};

	const handleCancelItem = async (reason: ItemCancelReason) => {
		if (!pendingCancelItem) {
			return;
		}
		const key = `cancel:${pendingCancelItem.orderId}:${pendingCancelItem.itemIndex}:${pendingCancelItem.unitIndex}`;
		await runConfirmingAction(key, async () => {
			await persistOrderEdit(
				pendingCancelItem.orderId,
				cancelItemUnit(
					orders,
					pendingCancelItem.orderId,
					pendingCancelItem.itemIndex,
					pendingCancelItem.unitIndex,
					reason
				)
			);
			setPendingCancelItem(null);
		});
	};

	const handleMarkDone = async (order: TOrder) => {
		await runConfirmingAction(`markDone:${order.id}`, async () => {
			if (!isOrderReady(order) || isOrderMarkedDone(order)) {
				setPendingMarkDone(null);
				return;
			}
			await persistOrderEdit(order.id, markOrderDone(orders, order.id));
			setPendingMarkDone(null);
		});
	};

	const handleWelcomeDrink = async (group: OrderGroup) => {
		await runConfirmingAction(`drink:${group.key}`, async () => {
			await persistGroupEdit(
				group,
				markTableWelcomeDrinkServed(orders, group)
			);
			setPendingWelcomeDrink(null);
		});
	};

	const handleComplementary = async (group: OrderGroup) => {
		await runConfirmingAction(`comp:${group.key}`, async () => {
			await persistGroupEdit(
				group,
				markTableComplementaryServed(orders, group)
			);
			setPendingComplementary(null);
		});
	};

	const handleKidMenu = async (group: OrderGroup) => {
		await runConfirmingAction(`kid:${group.key}`, async () => {
			await persistGroupEdit(group, markTableKidMenuServed(orders, group));
			setPendingKidMenu(null);
		});
	};

	const handleRequestToggleParcel = (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => {
		const item = order.items[itemIndex];
		if (!item) {
			return;
		}
		const group = findOrderGroupForOrder(orders, order.id);
		if (group && !canEditSession(group, deviceId)) {
			alertSessionLocked(group);
			return;
		}
		const display = getOrderItemUnitDisplay(item, unitIndex);
		if (display !== "pending" && display !== "fulfilled") {
			return;
		}
		setPendingParcelItem({
			orderId: order.id,
			itemIndex,
			unitIndex,
			dishName: item.name,
			isParcel: isItemUnitParcel(item, unitIndex),
		});
	};

	const handleToggleParcel = async () => {
		if (!pendingParcelItem) {
			return;
		}
		const { orderId, itemIndex, unitIndex } = pendingParcelItem;
		const order = orders.find((entry) => entry.id === orderId);
		const item = order?.items[itemIndex];
		const unitDisplay = item
			? getOrderItemUnitDisplay(item, unitIndex)
			: null;
		if (
			!order ||
			!item ||
			(unitDisplay !== "pending" && unitDisplay !== "fulfilled")
		) {
			setPendingParcelItem(null);
			return;
		}
		const key = `parcel:${orderId}:${itemIndex}:${unitIndex}`;
		await runConfirmingAction(key, async () => {
			await persistOrderEdit(
				orderId,
				toggleItemUnitParcel(orders, orderId, itemIndex, unitIndex)
			);
			setPendingParcelItem(null);
		});
	};

	const handleRequestToggleFulfill = (
		order: TOrder,
		itemIndex: number,
		unitIndex: number
	) => {
		const item = order.items[itemIndex];
		if (!item || isOrderMarkedDone(order)) {
			return;
		}
		const display = getOrderItemUnitDisplay(item, unitIndex);
		if (display !== "pending" && display !== "fulfilled") {
			return;
		}
		setPendingFulfillItem({
			orderId: order.id,
			itemIndex,
			unitIndex,
			dishName: item.name,
			isFulfilled: display === "fulfilled",
		});
	};

	const handleToggleFulfill = async () => {
		if (!pendingFulfillItem) {
			return;
		}
		const { orderId, itemIndex, unitIndex, isFulfilled } = pendingFulfillItem;
		const order = orders.find((entry) => entry.id === orderId);
		const item = order?.items[itemIndex];
		const unitDisplay = item
			? getOrderItemUnitDisplay(item, unitIndex)
			: null;
		if (
			!order ||
			!item ||
			isOrderMarkedDone(order) ||
			(unitDisplay !== "pending" && unitDisplay !== "fulfilled")
		) {
			setPendingFulfillItem(null);
			return;
		}
		const key = `fulfill:${orderId}:${itemIndex}:${unitIndex}`;
		await runConfirmingAction(key, async () => {
			await persistOrderEdit(
				orderId,
				setItemUnitFulfilled(orders, orderId, itemIndex, unitIndex, !isFulfilled)
			);
			setPendingFulfillItem(null);
		});
	};

	const handleNewOrderClick = () => {
		if (checklistProgress.open.done === 0) {
			setShowDayOpenWarning(true);
			return;
		}
		router.push(buildNewOrderHref());
	};

	const openNotesModal = (group: OrderGroup) => {
		setEditingNotesGroup(group);
		setNotesDraft(getGroupNotes(group) ?? "");
	};

	const handleSaveGroupNotes = async () => {
		if (!editingNotesGroup) {
			return;
		}
		await runPendingAction(`notes:${editingNotesGroup.key}`, async () => {
			await persistGroupEdit(
				editingNotesGroup,
				updateGroupNotes(orders, editingNotesGroup, notesDraft)
			);
			setEditingNotesGroup(null);
			setNotesDraft("");
		});
	};

	const openPaxModal = (group: OrderGroup) => {
		const current = getGroupPax(group);
		setEditingPaxGroup(group);
		setPaxDraft(current != null ? String(current) : "");
	};

	const handleSaveGroupPax = async () => {
		if (!editingPaxGroup) {
			return;
		}
		const paxNumber = parseInt(paxDraft.trim(), 10);
		if (Number.isNaN(paxNumber) || paxNumber < 1) {
			alert("Enter a valid pax count (at least 1).");
			return;
		}
		await runPendingAction(`pax:${editingPaxGroup.key}`, async () => {
			await persistGroupEdit(
				editingPaxGroup,
				updateGroupPax(orders, editingPaxGroup, paxNumber)
			);
			setEditingPaxGroup(null);
			setPaxDraft("");
		});
	};

	const openPhoneModal = (group: OrderGroup) => {
		const current = getGroupCustomerDetails(group).phone ?? "";
		setEditingPhoneGroup(group);
		setPhoneDraft(current);
	};

	const handleSaveGroupPhone = async () => {
		if (!editingPhoneGroup) {
			return;
		}
		const trimmed = phoneDraft.trim();
		if (trimmed && !isValidCustomerPhone(trimmed)) {
			alert(`Enter a valid ${CUSTOMER_PHONE_DIGITS}-digit phone number.`);
			return;
		}
		await runPendingAction(`phone:${editingPhoneGroup.key}`, async () => {
			await persistGroupEdit(
				editingPhoneGroup,
				updateGroupCustomerPhone(orders, editingPhoneGroup, trimmed)
			);
			setEditingPhoneGroup(null);
			setPhoneDraft("");
		});
	};

	const handleKotPrint = (order: TOrder) => {
		router.push(`/kot?orderId=${encodeURIComponent(order.id)}`);
	};

	const openChangeTableModal = (group: OrderGroup) => {
		setChangeTableGroup(group);
		setChangeTableDraft(normalizeTableNumbers(group.tableNumbers ?? []));
	};

	const toggleChangeTableDraft = (tableNumber: number) => {
		if (!changeTableGroup) {
			return;
		}
		if (!isTableAvailableForGroupMove(tableNumber, changeTableGroup, occupiedTables)) {
			return;
		}
		setChangeTableDraft((current) =>
			current.includes(tableNumber)
				? current.filter((value) => value !== tableNumber)
				: [...current, tableNumber].sort((a, b) => a - b)
		);
	};

	const handleChangeTableContinue = () => {
		if (!changeTableGroup) {
			return;
		}
		const newTables = normalizeTableNumbers(changeTableDraft);
		if (newTables.length === 0) {
			alert("Select at least one table.");
			return;
		}
		if (tableNumbersEqual(newTables, changeTableGroup.tableNumbers ?? [])) {
			alert("Choose a different table or seat combination.");
			return;
		}
		if (!canMoveTableGroupToTables(orders, changeTableGroup, newTables)) {
			alert("One or more selected tables are already occupied.");
			return;
		}
		setPendingChangeTableConfirm({
			group: changeTableGroup,
			newTables,
		});
		setChangeTableGroup(null);
		setChangeTableDraft([]);
	};

	const handleConfirmChangeTable = async () => {
		if (!pendingChangeTableConfirm) {
			return;
		}
		const { group, newTables } = pendingChangeTableConfirm;
		const key = `move-table:${group.key}`;
		await runConfirmingAction(key, async () => {
			await persistGroupEdit(
				group,
				moveTableGroupToTables(orders, group, newTables)
			);
			setPendingChangeTableConfirm(null);
		});
	};

	const proceedToBill = async (
		group: OrderGroup,
		options?: { lockAlreadyClaimed?: boolean }
	) => {
		if (!canEditSession(group, deviceId)) {
			alertSessionLocked(group);
			return;
		}
		if (!groupHasBillableItems(group)) {
			if (group.orders.length > 0) {
				setPendingCloseTable(group);
			}
			return;
		}
		// Claim lock before leaving for cart so peers see ownership.
		if (!options?.lockAlreadyClaimed) {
			await persistOrders(
				claimGroupSessionLock(orders, group, deviceId, deviceName)
			);
		}
		const cart = await orderGroupToBillCart(group);
		const oldestOrder = group.orders.reduce((oldest, order) =>
			order.createdAt < oldest.createdAt ? order : oldest
		);
		const sessionId = `order-session:${oldestOrder.id}`;
		const billingContext: BillingContext = {
			source: "orders",
			sessionId,
			groupKey: group.key,
			kind: group.kind,
			tableNumbers: group.tableNumbers ?? [],
			label: group.label,
			orderIds: group.orders.map((order) => order.id),
		};
		await localforage.setItem<TCart>("cart", cart);
		await localforage.setItem(BILLING_CONTEXT_KEY, billingContext);
		const session = await saveBillingSession(billingContext, cart);
		if (session.bill) {
			await localforage.setItem<TBill>("bill", session.bill);
		}
		router.push("/cart");
		// After navigate — chunking large billing payloads must not freeze cart paint.
		void notifyOrderOpsChange("billing");
	};

	const handleBill = (group: OrderGroup) => {
		if (!canEditSession(group, deviceId)) {
			alertSessionLocked(group);
			return;
		}
		if (!groupHasBillableItems(group)) {
			if (group.orders.length > 0) {
				setPendingCloseTable(group);
			}
			return;
		}

		if (group.kind === "table") {
			setPendingBillGroup(group);
			const counts = getGroupWaterBottleCounts(group);
			setWaterBottleDraft({
				"Water 1L": String(counts["Water 1L"]),
				"Water 500 ML": String(counts["Water 500 ML"]),
			});
			return;
		}

		void runPendingAction(`bill:${group.key}`, () => proceedToBill(group));
	};

	const handleConfirmBillWithWater = async () => {
		if (!pendingBillGroup) {
			return;
		}

		const targetCounts = emptyWaterBottleCounts();
		for (const dishName of WATER_DISH_NAMES) {
			const targetQty = parseInt(waterBottleDraft[dishName].trim(), 10);
			if (Number.isNaN(targetQty) || targetQty < 0) {
				alert(`Enter a valid count for ${dishName}.`);
				return;
			}
			targetCounts[dishName] = targetQty;
		}

		const groupKey = pendingBillGroup.key;
		if (isActionPending(`bill:${groupKey}`)) {
			return;
		}

		await runConfirmingAction(`bill:${groupKey}`, async () => {
			const liveGroup =
				groups.find((group) => group.key === groupKey) ??
				groupOrdersByTable(orders).find((group) => group.key === groupKey) ??
				pendingBillGroup;
			const waterPrices = await getWaterBottlePrices();
			const currentCounts = getGroupWaterBottleCounts(liveGroup);
			let billingGroup = liveGroup;
			let updatedOrders = orders;
			const toDecrement: { name: WaterDishName; price: number; qty: number }[] =
				[];
			const toReplenish: { name: WaterDishName; price: number; qty: number }[] =
				[];

			const changes = WATER_DISH_NAMES.map((dishName) => ({
				dishName,
				targetQty: targetCounts[dishName],
				currentQty: currentCounts[dishName],
			})).filter((change) => change.targetQty !== change.currentQty);
			const orderedChanges = [
				...changes.filter((change) => change.targetQty > change.currentQty),
				...changes.filter((change) => change.targetQty < change.currentQty),
			];

			for (const { dishName, targetQty, currentQty } of orderedChanges) {
				updatedOrders = syncGroupWaterBottleCount(
					updatedOrders,
					liveGroup,
					dishName,
					targetQty,
					waterPrices[dishName]
				);
				const delta = targetQty - currentQty;
				const waterItem = {
					name: dishName,
					price: waterPrices[dishName],
					qty: Math.abs(delta),
				};
				if (delta > 0) {
					toDecrement.push(waterItem);
				} else {
					toReplenish.push(waterItem);
				}
			}

			if (orderedChanges.length > 0) {
				const lockedOrders = claimGroupSessionLock(
					updatedOrders,
					liveGroup,
					deviceId,
					deviceName
				);
				await persistGroupEdit(liveGroup, lockedOrders);
				const dateKey = getTodayDateKey();
				if (toDecrement.length > 0) {
					await decrementInventoryForOrder(dateKey, toDecrement);
				}
				if (toReplenish.length > 0) {
					await replenishInventoryForOrder(dateKey, toReplenish);
				}
				const refreshedGroup = groupOrdersByTable(lockedOrders).find(
					(group) => group.key === groupKey
				);
				if (!refreshedGroup) {
					return;
				}
				billingGroup = refreshedGroup;
				await proceedToBill(billingGroup, { lockAlreadyClaimed: true });
			} else {
				await proceedToBill(billingGroup);
			}
			setPendingBillGroup(null);
			setWaterBottleDraft(emptyWaterBottleDrafts());
		});
	};

	const handleCloseTable = async (group: OrderGroup) => {
		await runConfirmingAction(`close:${group.key}`, async () => {
			if (!canEditSession(group, deviceId)) {
				alertSessionLocked(group);
				setPendingCloseTable(null);
				return;
			}
			const oldestOrder = group.orders.reduce((oldest, order) =>
				order.createdAt < oldest.createdAt ? order : oldest
			);
			const billingContext: BillingContext = {
				source: "orders",
				sessionId: `order-session:${oldestOrder.id}`,
				groupKey: group.key,
				kind: group.kind,
				tableNumbers: group.tableNumbers ?? [],
				label: group.label,
				orderIds: group.orders.map((order) => order.id),
			};
			const remaining = await closeTableFromBilling(billingContext);
			applyOrderState(remaining);
			setPendingCloseTable(null);
		});
	};

	const handleDiscardOrder = async (group: OrderGroup) => {
		await runConfirmingAction(`discard:${group.key}`, async () => {
			if (!canEditSession(group, deviceId)) {
				alertSessionLocked(group);
				setPendingDiscardGroup(null);
				return;
			}
			const remaining = await discardOrderGroup(group);
			applyOrderState(remaining);
			setPendingDiscardGroup(null);
		});
	};

	const handleAcquireLock = async (group: OrderGroup) => {
		await runConfirmingAction(`acquire-lock:${group.key}`, async () => {
			await persistOrders(
				claimGroupSessionLock(orders, group, deviceId, deviceName)
			);
			setPendingAcquireLock(null);
		});
	};

	const openAcquireLock = (group: OrderGroup) => {
		setPendingAcquireLock(group);
	};

	const orderSessionEditable = useCallback(
		(order: TOrder) => {
			const group = findOrderGroupForOrder(orders, order.id);
			if (!group) return true;
			return canEditSession(group, deviceId);
		},
		[orders, deviceId]
	);

	const hasOrders = groups.length > 0;
	const hasFilteredOrders = filteredGroups.length > 0;
	const hasFilteredChronologicalOrders = chronologicalOrders.length > 0;
	const hasFilteredItems = filteredItemGroups.length > 0;

	const hasActiveViewFilters = useMemo(() => {
		if (selectedTableFilters.length > 0) {
			return true;
		}
		if (activeTab !== "tables") {
			return true;
		}
		if (tableOrdersView !== "groups") {
			return true;
		}
		return itemsAggregatesView;
	}, [
		selectedTableFilters,
		activeTab,
		tableOrdersView,
		itemsAggregatesView,
	]);

	const viewFilterSummary = useMemo(() => {
		const parts: string[] = [];
		if (activeTab === "tables") {
			parts.push(tableOrdersView === "groups" ? "By table" : "All orders");
		} else {
			parts.push(itemsAggregatesView ? "Aggregates" : "Each item");
		}
		if (selectedTableFilters.length > 0) {
			parts.push(
				selectedTableFilters.length === 1
					? `Table ${selectedTableFilters[0]}`
					: `${selectedTableFilters.length} tables`
			);
		}
		return parts.join(" · ");
	}, [
		activeTab,
		tableOrdersView,
		itemsAggregatesView,
		selectedTableFilters,
	]);

	return (
		<LateClockProvider>
		<div className="ops-app-screen">
			<div className="sticky top-[var(--ops-top-banner-height,0px)] z-20 px-4 sm:px-6 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] pb-2 bg-transparent pointer-events-none">
				<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 pointer-events-auto">
					<OpsMenuButton />
					<div className="flex justify-center min-w-0 px-1">
						<div className="rounded-full bg-white border border-gray-200/80 shadow-md px-4 py-2 min-h-[44px] max-w-full flex flex-col justify-center">
							<h1 className="text-sm font-bold text-gray-900 truncate text-center">
								Orders
							</h1>
							{hasActiveViewFilters ? (
								<p className="text-[10px] text-gray-500 truncate text-center leading-tight mt-0.5">
									{viewFilterSummary}
								</p>
							) : null}
						</div>
					</div>
					<div className="flex items-center gap-2 shrink-0 justify-end">
						<OrderOpsSyncIndicator />
						{readyOrders.length > 0 && (
							<button
								type="button"
								onClick={() => setReadyModalOpen(true)}
								className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-green-500 text-white text-xs font-bold hover:bg-green-600 touch-manipulation px-2.5 shadow-md border border-green-600"
								aria-label={`${readyOrders.length} ready orders`}
							>
								{readyOrders.length}
							</button>
						)}
					</div>
				</div>
			</div>

			<div className="px-6 pb-6 pt-1 space-y-4">
				{loading && !hasOrders ? (
					<div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-400 text-sm">
						<LoadingSpinner className="h-6 w-6 text-gray-500" />
						<span>Loading orders...</span>
					</div>
				) : activeTab === "tables" ? (
					<>
						{!hasOrders ? (
							<div className="text-center py-16 text-gray-500">
								<p className="text-lg font-medium mb-2">No active orders</p>
								<p className="text-sm">
									Tap the + button to place a new order
								</p>
							</div>
						) : tableOrdersView === "orders" ? (
							!hasFilteredChronologicalOrders ? (
								<div className="text-center py-16 text-gray-500">
									<p className="text-lg font-medium mb-2">
										{selectedTableFilters.length > 0
											? "No orders for selected tables"
											: "No active orders"}
									</p>
									<p className="text-sm">
										{selectedTableFilters.length > 0
											? "Try another table filter or clear the filter."
											: "Tap the + button to place a new order"}
									</p>
								</div>
							) : (
								chronologicalOrders.map((order) => (
									<IndividualOrderCard
										key={order.id}
										order={order}
										sessionEditable={orderSessionEditable(order)}
										onEdit={setEditingOrder}
										onKotPrint={handleKotPrint}
										onRequestMarkDone={setPendingMarkDone}
										onRequestCancelItem={handleRequestCancelItem}
										onRequestToggleParcel={handleRequestToggleParcel}
										onRequestToggleFulfill={handleRequestToggleFulfill}
									/>
								))
							)
						) : !hasFilteredOrders ? (
							<div className="text-center py-16 text-gray-500">
								<p className="text-lg font-medium mb-2">
									{selectedTableFilters.length > 0
										? "No orders for selected tables"
										: "No active orders"}
								</p>
								<p className="text-sm">
									{selectedTableFilters.length > 0
										? "Try another table filter or clear the filter."
										: "Tap the + button to place a new order"}
								</p>
							</div>
						) : (
							filteredGroups.map((group) => (
								<TableOrderCard
									key={group.key}
									group={group}
									deviceId={deviceId}
									isActionPending={isActionPending}
									onBill={handleBill}
									onEditOrder={setEditingOrder}
									onKotPrint={handleKotPrint}
									onRequestMarkDone={setPendingMarkDone}
									onRequestWelcomeDrink={setPendingWelcomeDrink}
									onRequestComplementary={setPendingComplementary}
									onRequestKidMenu={setPendingKidMenu}
									onRequestCancelItem={handleRequestCancelItem}
									onRequestToggleParcel={handleRequestToggleParcel}
									onRequestToggleFulfill={handleRequestToggleFulfill}
									onEditNotes={openNotesModal}
									onEditPax={openPaxModal}
									onAddPhone={openPhoneModal}
									onCloseOrder={setPendingDiscardGroup}
									onChangeTable={openChangeTableModal}
									onAcquireLock={openAcquireLock}
								/>
							))
						)}
					</>
				) : !hasFilteredItems ? (
					<div className="text-center py-16 text-gray-500 text-sm">
						{selectedTableFilters.length > 0
							? "No items for selected tables"
							: "No items in active orders"}
					</div>
				) : (
					filteredItemGroups.map((group) => (
						<ItemGroupCard
							key={group.name}
							group={group}
							orders={orders}
							onToggleUnit={handleToggleDishUnit}
							onRequestCancelUnit={handleRequestCancelUnit}
							aggregatesView={itemsAggregatesView}
						/>
					))
				)}

				{!(loading && !hasOrders) ? (
					<div className="grid grid-cols-2 gap-3 pt-2">
						<ChecklistProgressCard
							title="Day open"
							href="/order/day-open"
							progress={checklistProgress.open}
						/>
						<ChecklistProgressCard
							title="Day close"
							href="/order/day-close"
							progress={checklistProgress.close}
						/>
					</div>
				) : null}
			</div>

			<div className="fixed left-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-20">
				<button
					type="button"
					onClick={() => setViewFiltersOpen(true)}
					className="relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-gray-900 text-white shadow-lg hover:bg-gray-800 touch-manipulation"
					aria-label="View filters"
				>
					<FilterIcon className="w-5 h-5 shrink-0" />
					{hasActiveViewFilters ? (
						<span className="absolute top-0 right-0 h-3 w-3 rounded-full bg-green-500 border-2 border-white" />
					) : null}
				</button>
			</div>

			{activeTableNumbers.length > 0 ? (
				<div
					className="fixed right-3 top-1/2 z-20 -translate-y-1/2 max-h-[min(60vh,24rem)] overflow-y-auto rounded-full border border-gray-200/90 bg-white/95 shadow-lg backdrop-blur-sm px-1.5 py-2"
					role="toolbar"
					aria-label="Active table filters"
				>
					<div className="flex flex-col items-center gap-1.5">
						{activeTableNumbers.map((tableNumber) => {
							const isSelected = selectedTableFilters.includes(tableNumber);
							return (
								<button
									key={tableNumber}
									type="button"
									onClick={() => toggleTableFilter(tableNumber)}
									aria-pressed={isSelected}
									aria-label={`Filter table ${tableNumber}`}
									className={`shrink-0 h-9 w-9 rounded-full text-sm font-semibold touch-manipulation transition-colors ${
										isSelected
											? "bg-green-500 text-white"
											: "bg-gray-100 text-gray-800 hover:bg-gray-200"
									}`}
								>
									{tableNumber}
								</button>
							);
						})}
					</div>
				</div>
			) : null}

			<button
				type="button"
				onClick={handleNewOrderClick}
				className="fixed right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-green-500 text-white text-sm font-semibold shadow-lg px-4 hover:bg-green-600 touch-manipulation z-20"
				aria-label="New order"
			>
				<PlusIcon className="w-5 h-5 shrink-0" />
				Order
			</button>

			{viewFiltersOpen ? (
				<OrderViewFiltersSheet
					activeTab={activeTab}
					onActiveTabChange={setActiveTab}
					tableOrdersView={tableOrdersView}
					onTableOrdersViewChange={setTableOrdersView}
					itemsAggregatesView={itemsAggregatesView}
					onItemsAggregatesViewChange={setItemsAggregatesView}
					onClose={() => setViewFiltersOpen(false)}
				/>
			) : null}

			{readyModalOpen && readyOrders.length > 0 && (
				<ReadyOrdersModal
					orders={readyOrders}
					onClose={() => setReadyModalOpen(false)}
				/>
			)}

			{showDayOpenWarning && (
				<DayOpenWarningModal
					onGoToChecklist={() => {
						setShowDayOpenWarning(false);
						router.push("/order/day-open");
					}}
					onProceed={() => {
						setShowDayOpenWarning(false);
						router.push(buildNewOrderHref());
					}}
					onClose={() => setShowDayOpenWarning(false)}
				/>
			)}

			{pendingMarkDone && (
				<ConfirmOrderActionModal
					title="Mark order done?"
					message={`Confirm this order from ${formatOrderTime(pendingMarkDone.createdAt)} is complete. This cannot be undone.`}
					confirmLabel="Mark done"
					confirming={confirmingAction === `markDone:${pendingMarkDone.id}`}
					onCancel={() => setPendingMarkDone(null)}
					onConfirm={() => void handleMarkDone(pendingMarkDone)}
				/>
			)}

			{pendingWelcomeDrink && (
				<ConfirmOrderActionModal
					title="Welcome drink served?"
					message={`Is welcome drink served for ${pendingWelcomeDrink.label}?`}
					confirmLabel="Yes, served"
					confirming={confirmingAction === `drink:${pendingWelcomeDrink.key}`}
					onCancel={() => setPendingWelcomeDrink(null)}
					onConfirm={() => void handleWelcomeDrink(pendingWelcomeDrink)}
				/>
			)}

			{pendingComplementary && (
				<ConfirmOrderActionModal
					title="Complementary served?"
					message={`Is complementary served for ${pendingComplementary.label}?`}
					confirmLabel="Yes, served"
					confirming={confirmingAction === `comp:${pendingComplementary.key}`}
					onCancel={() => setPendingComplementary(null)}
					onConfirm={() => void handleComplementary(pendingComplementary)}
				/>
			)}

			{pendingKidMenu && (
				<ConfirmOrderActionModal
					title="Kid menu served?"
					message={`Is kid menu served for ${pendingKidMenu.label}?`}
					confirmLabel="Yes, served"
					confirming={confirmingAction === `kid:${pendingKidMenu.key}`}
					onCancel={() => setPendingKidMenu(null)}
					onConfirm={() => void handleKidMenu(pendingKidMenu)}
				/>
			)}

			{changeTableGroup && (
				<ChangeTableSheetModal
					group={changeTableGroup}
					selectedTables={changeTableDraft}
					occupiedTables={occupiedTables}
					onToggleTable={toggleChangeTableDraft}
					onContinue={handleChangeTableContinue}
					onClose={() => {
						setChangeTableGroup(null);
						setChangeTableDraft([]);
					}}
				/>
			)}

			{pendingChangeTableConfirm && (
				<ConfirmOrderActionModal
					title="Change table?"
					message={`Move ${pendingChangeTableConfirm.group.label} to ${formatTableGroupLabel(pendingChangeTableConfirm.newTables)}? All orders in this group will be updated.`}
					confirmLabel="Change table"
					confirming={
						confirmingAction ===
						`move-table:${pendingChangeTableConfirm.group.key}`
					}
					onCancel={() => {
						if (
							confirmingAction ===
							`move-table:${pendingChangeTableConfirm.group.key}`
						) {
							return;
						}
						setPendingChangeTableConfirm(null);
					}}
					onConfirm={() => void handleConfirmChangeTable()}
				/>
			)}

			{pendingBillGroup && (
				<WaterBottlesModal
					groupLabel={pendingBillGroup.label}
					values={waterBottleDraft}
					onChange={(dishName, value) =>
						setWaterBottleDraft((current) => ({
							...current,
							[dishName]: value,
						}))
					}
					confirming={isActionPending(`bill:${pendingBillGroup.key}`)}
					onCancel={() => {
						if (isActionPending(`bill:${pendingBillGroup.key}`)) {
							return;
						}
						setPendingBillGroup(null);
						setWaterBottleDraft(emptyWaterBottleDrafts());
					}}
					onConfirm={() => void handleConfirmBillWithWater()}
				/>
			)}

			{pendingCloseTable && (
				<ConfirmOrderActionModal
					title="Nothing to bill"
					message={`All items on ${pendingCloseTable.label} are cancelled or removed. ${
						pendingCloseTable.kind === "table"
							? "Close the table to clear it from active orders."
							: "Close this group to clear it from active orders."
					}`}
					confirmLabel={
						pendingCloseTable.kind === "table" ? "Close table" : "Close"
					}
					cancelLabel="Don't do anything"
					confirming={confirmingAction === `close:${pendingCloseTable.key}`}
					onCancel={() => setPendingCloseTable(null)}
					onConfirm={() => void handleCloseTable(pendingCloseTable)}
				/>
			)}

			{pendingDiscardGroup && (
				<ConfirmOrderActionModal
					title="Close order permanently?"
					message={`This is a destructive action. ${pendingDiscardGroup.label} will not be saved to the database and will be permanently lost. This cannot be undone.`}
					confirmLabel="Close order"
					cancelLabel="Keep order"
					destructive
					confirming={confirmingAction === `discard:${pendingDiscardGroup.key}`}
					onCancel={() => setPendingDiscardGroup(null)}
					onConfirm={() => void handleDiscardOrder(pendingDiscardGroup)}
				/>
			)}

			{pendingAcquireLock && (
				<ConfirmOrderActionModal
					title="Acquire session lock?"
					message={`${getGroupSessionLock(pendingAcquireLock)?.deviceName ?? "Another device"} will lose edit access to ${pendingAcquireLock.label}. Any mid-edit changes on that device may be lost.`}
					confirmLabel="Acquire lock"
					confirming={
						confirmingAction === `acquire-lock:${pendingAcquireLock.key}`
					}
					onCancel={() => setPendingAcquireLock(null)}
					onConfirm={() => void handleAcquireLock(pendingAcquireLock)}
				/>
			)}

			{editingNotesGroup && (
				<GroupNotesModal
					group={editingNotesGroup}
					draft={notesDraft}
					saving={Boolean(pendingActions[`notes:${editingNotesGroup.key}`])}
					onDraftChange={setNotesDraft}
					onClose={() => {
						setEditingNotesGroup(null);
						setNotesDraft("");
					}}
					onSave={() => void handleSaveGroupNotes()}
				/>
			)}

			{editingPaxGroup && (
				<GroupPaxModal
					group={editingPaxGroup}
					draft={paxDraft}
					saving={Boolean(pendingActions[`pax:${editingPaxGroup.key}`])}
					onDraftChange={setPaxDraft}
					onClose={() => {
						setEditingPaxGroup(null);
						setPaxDraft("");
					}}
					onSave={() => void handleSaveGroupPax()}
				/>
			)}

			{editingPhoneGroup && (
				<GroupPhoneModal
					group={editingPhoneGroup}
					draft={phoneDraft}
					saving={Boolean(pendingActions[`phone:${editingPhoneGroup.key}`])}
					onDraftChange={setPhoneDraft}
					onClose={() => {
						setEditingPhoneGroup(null);
						setPhoneDraft("");
					}}
					onSave={() => void handleSaveGroupPhone()}
				/>
			)}

			{editingOrder && (
				<EditOrderModal
					order={editingOrder}
					onClose={() => setEditingOrder(null)}
					onSaved={() => loadOrders({ background: true })}
				/>
			)}

			{pendingFulfillItem && (
				<ConfirmOrderActionModal
					title={
						pendingFulfillItem.isFulfilled
							? "Mark item not done?"
							: "Mark item done?"
					}
					message={
						pendingFulfillItem.isFulfilled
							? `Move ${pendingFulfillItem.dishName} back to pending?`
							: `Confirm ${pendingFulfillItem.dishName} is done?`
					}
					confirmLabel={
						pendingFulfillItem.isFulfilled ? "Move to pending" : "Mark done"
					}
					confirming={
						confirmingAction ===
						`fulfill:${pendingFulfillItem.orderId}:${pendingFulfillItem.itemIndex}:${pendingFulfillItem.unitIndex}`
					}
					onCancel={() => setPendingFulfillItem(null)}
					onConfirm={() => void handleToggleFulfill()}
				/>
			)}

			{pendingParcelItem && (
				<ConfirmOrderActionModal
					title={
						pendingParcelItem.isParcel ? "Remove parcel?" : "Mark for parcel?"
					}
					message={
						pendingParcelItem.isParcel
							? `Remove parcel packing for ${pendingParcelItem.dishName}?`
							: `Mark ${pendingParcelItem.dishName} for parcel packing?`
					}
					confirmLabel={pendingParcelItem.isParcel ? "Remove parcel" : "Mark parcel"}
					confirming={
						confirmingAction ===
						`parcel:${pendingParcelItem.orderId}:${pendingParcelItem.itemIndex}:${pendingParcelItem.unitIndex}`
					}
					onCancel={() => setPendingParcelItem(null)}
					onConfirm={() => void handleToggleParcel()}
				/>
			)}

			{pendingCancelItem && (
				<CancelItemModal
					dishName={pendingCancelItem.dishName}
					confirming={
						confirmingAction ===
						`cancel:${pendingCancelItem.orderId}:${pendingCancelItem.itemIndex}:${pendingCancelItem.unitIndex}`
					}
					onCancel={() => setPendingCancelItem(null)}
					onConfirm={(reason) => void handleCancelItem(reason)}
				/>
			)}
		</div>
		</LateClockProvider>
	);
}

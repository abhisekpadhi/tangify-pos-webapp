"use client";

import { OpsPageShell } from "@/components/feature/layout/ops-page-shell";
import {
  LoadingSpinner,
  TouchActionButton,
  TouchIconButton,
} from "@/components/ui/touch-controls";
import {
  BillingContext,
  BILLING_CONTEXT_KEY,
  TCart,
  TDish,
  TMenu,
  TMenuApiItem,
} from "@/src/models/common";
import { saveBillingSession } from "@/src/utils/billing_state";
import { notifyOrderOpsChange } from "@/src/utils/order_ops_sync";
import {
  fetchAndCacheMenuItems,
  getCachedMenuItems,
} from "@/src/utils/menu_cache";
import { buildMenuFromApiItems, stringToColor, getMenuDisplayName, menuItemMatchesSearch, shouldShowMenuBillName } from "@/src/utils/menu_utils";
import localforage from "localforage";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useInFlightLock } from "@/src/utils/in_flight";

function RefreshIcon({ className }: { className?: string }) {
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
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

const FreeflowPage: React.FC = () => {
  const router = useRouter();

  const [fetchingMenu, setFetchingMenu] = useState(true);
  const [refreshingMenu, setRefreshingMenu] = useState(false);
  const [menu, setMenu] = useState<TMenu | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [cartQuantities, setCartQuantities] = useState<Record<string, number>>(
    {}
  );
  const [categories, setCategories] = useState<string[]>([]);
  const [goingToCart, setGoingToCart] = useState(false);
  const cartLock = useInFlightLock();

  const applyMenuItems = useCallback((items: TMenuApiItem[]) => {
    setMenu(buildMenuFromApiItems(items));
    setLoadError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setFetchingMenu(true);
      try {
        const cached = await getCachedMenuItems();
        if (cached) {
          if (!cancelled) {
            applyMenuItems(cached);
          }
          return;
        }

        const items = await fetchAndCacheMenuItems();
        if (!cancelled) {
          applyMenuItems(items);
        }
      } catch (error) {
        console.error("Error loading menu:", error);
        if (!cancelled) {
          setLoadError("Could not load menu. Tap refresh to try again.");
          setMenu(null);
        }
      } finally {
        if (!cancelled) {
          setFetchingMenu(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyMenuItems]);

  const handleRefreshMenu = useCallback(async () => {
    setRefreshingMenu(true);
    try {
      const items = await fetchAndCacheMenuItems();
      applyMenuItems(items);
    } catch (error) {
      console.error("Error refreshing menu:", error);
      setLoadError("Could not refresh menu. Try again.");
    } finally {
      setRefreshingMenu(false);
    }
  }, [applyMenuItems]);

  useEffect(() => {
    localforage
      .getItem<TCart>("cart")
      .then((cart) => {
        if (cart?.items) {
          const quantities: Record<string, number> = {};
          cart.items.forEach((item: TDish) => {
            quantities[item.name] = item.qty;
          });
          setCartQuantities(quantities);
        }
      })
      .catch((error) => {
        console.error("Failed to load cart:", error);
      });
  }, []);

  useEffect(() => {
    if (menu) {
      setCategories(Object.keys(menu));
      return;
    }
    setCategories([]);
  }, [menu]);

  const allItems = useMemo(() => {
    if (!menu) {
      return [];
    }

    const itemsWithCategory: {
      category: string;
      name: string;
      internal_name?: string;
      description: string;
      price: string;
      is_veg: boolean;
    }[] = [];

    Object.entries(menu).forEach(([category, items]) => {
      items.forEach((item) => {
        itemsWithCategory.push({
          category,
          name: item.name,
          ...(item.internal_name ? { internal_name: item.internal_name } : {}),
          description: item.description,
          price: item.price,
          is_veg: item.is_veg,
        });
      });
    });

    return itemsWithCategory;
  }, [menu]);

  const visibleItems = useMemo(() => {
    let filtered = allItems;

    if (selectedCategory) {
      filtered = filtered.filter(
        (item) => item.category === selectedCategory
      );
    }

    if (searchTerm.trim()) {
      filtered = filtered.filter((item) => menuItemMatchesSearch(item, searchTerm));
    }

    return filtered;
  }, [allItems, selectedCategory, searchTerm]);

  const goToCart = async () => {
    if (!cartLock.tryLock()) {
      return;
    }
    setGoingToCart(true);
    try {
    let context =
      await localforage.getItem<BillingContext>(BILLING_CONTEXT_KEY);
    if (!context || context.source !== "freeflow" || !context.sessionId) {
      const sessionId = `freeflow:${crypto.randomUUID()}`;
      context = {
        source: "freeflow",
        sessionId,
        groupKey: sessionId,
        kind: "takeaway",
        tableNumbers: [],
        label: "Freeflow",
      };
      await localforage.setItem(BILLING_CONTEXT_KEY, context);
    }
    const cart = (await localforage.getItem<TCart>("cart")) ?? { items: [] };
    await saveBillingSession(context, cart);
    router.push("/cart");
    // Don't await — Ably billing notify can be large; keep cart interactive.
    void notifyOrderOpsChange("billing");
    } catch (error) {
      console.error("Failed to open cart:", error);
      alert("Failed to open cart. Please try again.");
      setGoingToCart(false);
      cartLock.unlock();
    }
  };

  const updateCartAndQuantities = (
    itemName: string,
    updater: (currentQty: number, cart: TCart) => TCart
  ) => {
    localforage.getItem<TCart>("cart").then((existingCart) => {
      const baseCart: TCart = existingCart ?? { items: [] };
      const currentQty = cartQuantities[itemName] || 0;
      const newCart = updater(currentQty, baseCart);

      localforage.setItem<TCart>("cart", newCart).then(() => {
        const updatedQty =
          newCart.items.find((i) => i.name === itemName)?.qty ?? 0;
        setCartQuantities((prev) => {
          const next = { ...prev };
          if (updatedQty > 0) {
            next[itemName] = updatedQty;
          } else {
            delete next[itemName];
          }
          return next;
        });
      });
    });
  };

  const handleAddItem = (item: { name: string; price: string }) => {
    updateCartAndQuantities(item.name, (_, cart) => {
      const existingIndex = cart.items.findIndex(
        (i: TDish) => i.name === item.name
      );

      if (existingIndex === -1) {
        const priceNumber = parseFloat(item.price);
        const newItem: TDish = {
          name: item.name,
          qty: 1,
          price: isNaN(priceNumber) ? 0 : priceNumber,
        };
        return { items: [...cart.items, newItem] };
      }

      const newItems = [...cart.items];
      newItems[existingIndex] = {
        ...newItems[existingIndex],
        qty: newItems[existingIndex].qty + 1,
      };
      return { items: newItems };
    });
  };

  const handleIncrement = (item: { name: string; price: string }) => {
    handleAddItem(item);
  };

  const handleDecrement = (item: { name: string }) => {
    updateCartAndQuantities(item.name, (currentQty, cart) => {
      if (currentQty <= 1) {
        return {
          items: cart.items.filter((i: TDish) => i.name !== item.name),
        };
      }

      return {
        items: cart.items.map((i: TDish) =>
          i.name === item.name ? { ...i, qty: i.qty - 1 } : i
        ),
      };
    });
  };

  return (
    <OpsPageShell
      title="Freeflow"
      trailing={
        <>
          <TouchIconButton
            onClick={() => void handleRefreshMenu()}
            loading={refreshingMenu}
            disabled={fetchingMenu}
            ariaLabel={refreshingMenu ? "Refreshing menu" : "Refresh menu"}
            className="bg-gray-100 text-gray-700 active:bg-gray-200"
          >
            <RefreshIcon className="w-4 h-4" />
          </TouchIconButton>
          <TouchActionButton
            onClick={() => void goToCart()}
            loading={goingToCart}
            disabled={goingToCart}
            className="bg-green-500 text-white active:bg-green-600 min-w-[72px]"
          >
            Cart
          </TouchActionButton>
        </>
      }
    >
      <div className="mb-4">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search for items across all categories"
          className="w-full border border-gray-300 rounded-lg px-3 py-3 text-sm touch-manipulation"
        />
      </div>

      {fetchingMenu ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-500 text-sm">
          <LoadingSpinner className="h-6 w-6 text-gray-500" />
          <span>Loading menu...</span>
        </div>
      ) : loadError && !menu ? (
        <div className="text-center py-12 text-red-500 text-sm">{loadError}</div>
      ) : (
        <>
          {loadError ? (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {loadError}
            </div>
          ) : null}
          <div className="flex gap-3 mb-6 overflow-x-auto pb-2 touch-manipulation">
            {categories.map((category, index) => {
              const isSelected = selectedCategory === category;
              const baseOpacity =
                selectedCategory === null || isSelected
                  ? "opacity-100"
                  : "opacity-50";

              return (
                <button
                  key={`${category}-${index}`}
                  type="button"
                  style={{ backgroundColor: stringToColor(category) }}
                  className={`whitespace-nowrap px-4 py-2 text-center font-bold text-xs rounded-lg cursor-pointer transition-transform ${baseOpacity} ${
                    isSelected ? "ring-2 ring-black scale-105" : ""
                  }`}
                  onClick={() =>
                    setSelectedCategory((prev) =>
                      prev === category ? null : category
                    )
                  }
                >
                  {category}
                </button>
              );
            })}
          </div>
          <div className="space-y-3 mb-8">
            {visibleItems.map((item, index) => (
              <div
                key={`${item.category}-${item.name}-${index}`}
                className="flex items-center justify-between border border-gray-200 rounded-lg px-4 py-3 bg-white shadow-sm"
              >
                <div className="mr-4">
                  <p className="font-semibold text-sm">{getMenuDisplayName(item)}</p>
                  {shouldShowMenuBillName(item) ? (
                    <p className="text-[10px] text-gray-500">{item.name}</p>
                  ) : null}
                  {item.description ? (
                    <p className="text-xs text-gray-600 mt-1">
                      {item.description}
                    </p>
                  ) : null}
                  <p className="text-[10px] text-gray-500 mt-1 uppercase">
                    {item.category}
                  </p>
                </div>
                <div className="flex flex-col items-end space-y-2">
                  <p className="font-medium text-sm">₹{item.price}</p>
                  {cartQuantities[item.name] && cartQuantities[item.name] > 0 ? (
                    <div className="flex items-center space-x-2">
                      <button
                        type="button"
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-red-100 text-red-700 text-lg leading-none"
                        onClick={() => handleDecrement(item)}
                      >
                        -
                      </button>
                      <span className="min-w-[1.5rem] text-center text-sm font-medium">
                        {cartQuantities[item.name]}
                      </span>
                      <button
                        type="button"
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-green-100 text-green-700 text-lg leading-none"
                        onClick={() => handleIncrement(item)}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="px-3 py-1 rounded-full bg-green-200 text-xs font-semibold"
                      onClick={() => handleAddItem(item)}
                    >
                      + ADD
                    </button>
                  )}
                </div>
              </div>
            ))}
            {visibleItems.length === 0 && (
              <div className="text-center text-sm text-gray-500">
                No items found for the current filters.
              </div>
            )}
          </div>
        </>
      )}
    </OpsPageShell>
  );
};

export default FreeflowPage;

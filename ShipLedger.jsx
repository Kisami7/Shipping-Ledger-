import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Plus, Trash2, Pencil, ArrowLeft, Settings as SettingsIcon, Moon, Sun,
  RefreshCw, Package, ShoppingCart, X, Truck, Image as ImageIcon,
  ChevronRight, AlertTriangle, Building2, Wallet, Check
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const CURRENCIES = [
  "USD","EUR","GBP","JPY","CNY","KRW","HKD","SGD","AUD","CAD","CHF","INR",
  "THB","MYR","IDR","PHP","VND","TWD","NZD","MXN","BRL","ZAR","AED","SAR",
  "TRY","RUB","SEK","NOK","DKK","PLN","CZK","ILS","EGP","NGN","KES","PKR",
  "BDT","ARS","CLP","COP","QAR"
];

const STORAGE_KEY = "shipledger-data";
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between forex refreshes

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

const emptyCompany = () => ({
  id: uid(), name: "", region: "", currency: "USD", basePrice: "", additionalPrice: ""
});

const emptyCart = () => ({
  id: uid(), name: "New Cart", image: "", items: [],
  cardFeeType: "percent", cardFeeValue: "", cardFeeCurrency: "USD",
  totalCurrency: "USD"
});

const emptyItem = () => ({
  id: uid(), name: "", image: "", platform: "", price: "", currency: "USD",
  tax: "", note: "", weight: "", shippingType: "free",
  fixedShippingAmount: "", fixedShippingCurrency: "USD", forwardCompanyId: ""
});

const defaultData = () => ({
  settings: { apiKey: "", theme: "light", lastRefresh: 0 },
  rates: null, // { base, rates, timestamp }
  companies: [],
  carts: []
});

/* ------------------------------------------------------------------ */
/* Math helpers                                                       */
/* ------------------------------------------------------------------ */

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function convert(amount, from, to, rates) {
  if (!rates || !rates.rates) return null;
  if (!from || !to) return null;
  if (from === to) return amount;
  const rFrom = from === rates.base ? 1 : rates.rates[from];
  const rTo = to === rates.base ? 1 : rates.rates[to];
  if (!rFrom || !rTo) return null;
  return (amount / rFrom) * rTo;
}

function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || isNaN(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: currency || "USD", currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 2
    }).format(amount);
  } catch (e) {
    return `${amount.toFixed(2)} ${currency || ""}`;
  }
}

// The "0.5kg rule": a base price covers the first 0.5kg, then every
// additional (or partial) 0.5kg increment is charged at the additional rate.
function calcForwardShipping(weightKg, company) {
  const w = num(weightKg);
  const base = num(company.basePrice);
  const add = num(company.additionalPrice);
  if (w <= 0) return 0;
  if (w <= 0.5) return base;
  const extra = w - 0.5;
  const units = Math.ceil(extra / 0.5 - 1e-9);
  return base + units * add;
}

function calcItemShipping(item, companies) {
  if (item.shippingType === "free") return { amount: 0, currency: item.currency, ok: true };
  if (item.shippingType === "fixed") {
    return { amount: num(item.fixedShippingAmount), currency: item.fixedShippingCurrency || item.currency, ok: true };
  }
  if (item.shippingType === "forward") {
    const company = companies.find((c) => c.id === item.forwardCompanyId);
    if (!company) return { amount: 0, currency: item.currency, ok: false };
    return { amount: calcForwardShipping(item.weight, company), currency: company.currency, ok: true };
  }
  return { amount: 0, currency: item.currency, ok: true };
}

function calcItemCost(item) {
  return num(item.price) * (1 + num(item.tax) / 100);
}

function calcCartTotals(cart, rates, companies) {
  const target = cart.totalCurrency || "USD";
  let subtotal = 0;
  let missingRate = false;
  let missingCompany = false;
  const rows = cart.items.map((item) => {
    const base = calcItemCost(item);
    const baseConv = convert(base, item.currency, target, rates);
    const ship = calcItemShipping(item, companies);
    if (!ship.ok) missingCompany = true;
    const shipConv = ship.amount ? convert(ship.amount, ship.currency, target, rates) : 0;
    if (baseConv === null || (ship.amount && shipConv === null)) missingRate = true;
    const rowTotal = (baseConv || 0) + (shipConv || 0);
    subtotal += rowTotal;
    return { item, base, shipAmount: ship.amount, shipCurrency: ship.currency, rowTotal };
  });
  let feeAmount = 0;
  if (cart.cardFeeType === "percent") {
    feeAmount = subtotal * (num(cart.cardFeeValue) / 100);
  } else if (cart.cardFeeType === "fixed") {
    const conv = convert(num(cart.cardFeeValue), cart.cardFeeCurrency || target, target, rates);
    if (conv === null) missingRate = true;
    feeAmount = conv || 0;
  }
  return { rows, subtotal, feeAmount, total: subtotal + feeAmount, missingRate, missingCompany, target };
}

/* ------------------------------------------------------------------ */
/* Small UI atoms                                                     */
/* ------------------------------------------------------------------ */

function Field({ label, children, hint }) {
  return (
    <label className="block mb-3">
      <span className="block text-[11px] uppercase tracking-wider mb-1 text-[var(--muted)] font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs mt-1 text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] transition-colors";

function TextInput(props) {
  return <input {...props} className={inputCls + " " + (props.className || "")} />;
}

function CurrencySelect({ value, onChange, id }) {
  const listId = id || "currency-list";
  return (
    <>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase().slice(0, 3))}
        className={inputCls + " font-[JetBrains_Mono,monospace] uppercase"}
        placeholder="USD"
        maxLength={3}
      />
      <datalist id={listId}>
        {CURRENCIES.map((c) => <option value={c} key={c} />)}
      </datalist>
    </>
  );
}

function Button({ children, variant = "default", className = "", ...rest }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const variants = {
    default: "bg-[var(--accent)] text-white hover:opacity-90",
    ghost: "bg-transparent text-[var(--text)] hover:bg-[var(--surface-2)] border border-[var(--border)]",
    subtle: "bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--border)]",
    danger: "bg-transparent text-[var(--danger)] hover:bg-[var(--danger)]/10 border border-[var(--danger)]/30"
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...rest}>{children}</button>;
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div
        className={`bg-[var(--bg)] w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-md"} sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col border border-[var(--border)]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0">
          <h2 className="font-[Space_Grotesk,sans-serif] font-semibold text-base text-[var(--text)]">{title}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-[var(--surface-2)] text-[var(--muted)]">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ImageThumb({ src, size = 44, rounded = "rounded-lg" }) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) {
    return (
      <div className={`shrink-0 ${rounded} bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-[var(--muted)]`} style={{ width: size, height: size }}>
        <ImageIcon size={size * 0.4} />
      </div>
    );
  }
  return (
    <img
      src={src} alt="" onError={() => setErrored(true)}
      className={`shrink-0 ${rounded} object-cover border border-[var(--border)]`}
      style={{ width: size, height: size }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Item Form Modal                                                    */
/* ------------------------------------------------------------------ */

function ItemForm({ initial, companies, onSave, onClose, onDelete }) {
  const [item, setItem] = useState(initial);
  const set = (k, v) => setItem((s) => ({ ...s, [k]: v }));

  const regions = useMemo(() => {
    const map = {};
    companies.forEach((c) => {
      const r = c.region || "Other";
      map[r] = map[r] || [];
      map[r].push(c);
    });
    return map;
  }, [companies]);

  const previewShip = calcItemShipping(item, companies);

  return (
    <Modal title={initial._isNew ? "Add item" : "Edit item"} onClose={onClose} wide>
      <Field label="Item name">
        <TextInput value={item.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Wireless keyboard" />
      </Field>
      <Field label="Image URL" hint="Paste a link to an image of the item">
        <TextInput value={item.image} onChange={(e) => set("image", e.target.value)} placeholder="https://…" />
      </Field>
      <Field label="Shopping platform">
        <TextInput value={item.platform} onChange={(e) => set("platform", e.target.value)} placeholder="e.g. Amazon, Rakuten, Taobao" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Price">
          <TextInput type="number" step="0.01" value={item.price} onChange={(e) => set("price", e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Currency">
          <CurrencySelect value={item.currency} onChange={(v) => set("currency", v)} id="cur-price" />
        </Field>
      </div>

      <Field label="Tax" hint="Percentage applied on top of price">
        <div className="relative">
          <TextInput type="number" step="0.01" value={item.tax} onChange={(e) => set("tax", e.target.value)} placeholder="0" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--muted)]">%</span>
        </div>
      </Field>

      <Field label="Note">
        <textarea
          value={item.note} onChange={(e) => set("note", e.target.value)}
          className={inputCls + " min-h-[64px] resize-y"} placeholder="Optional notes…"
        />
      </Field>

      <div className="my-4 border-t border-dashed border-[var(--border)]" />

      <Field label="Item weight (kg)" hint="Used to calculate forwarding cost">
        <TextInput type="number" step="0.01" value={item.weight} onChange={(e) => set("weight", e.target.value)} placeholder="0.00" />
      </Field>

      <Field label="Shipping">
        <div className="flex gap-2 mb-3">
          {[
            { v: "free", label: "Free" },
            { v: "fixed", label: "Fixed rate" },
            { v: "forward", label: "Forward" }
          ].map((opt) => (
            <button
              key={opt.v} type="button" onClick={() => set("shippingType", opt.v)}
              className={`flex-1 rounded-lg border px-2 py-2 text-sm font-medium transition-colors ${
                item.shippingType === opt.v
                  ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>

      {item.shippingType === "fixed" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shipping amount">
            <TextInput type="number" step="0.01" value={item.fixedShippingAmount} onChange={(e) => set("fixedShippingAmount", e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Currency">
            <CurrencySelect value={item.fixedShippingCurrency} onChange={(v) => set("fixedShippingCurrency", v)} id="cur-ship" />
          </Field>
        </div>
      )}

      {item.shippingType === "forward" && (
        <div>
          {companies.length === 0 ? (
            <div className="flex items-start gap-2 text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg p-3 mb-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>No forwarding companies yet. Add one from the Companies tab first.</span>
            </div>
          ) : (
            <Field label="Forwarding company">
              <select value={item.forwardCompanyId} onChange={(e) => set("forwardCompanyId", e.target.value)} className={inputCls}>
                <option value="">Select a company…</option>
                {Object.entries(regions).map(([region, list]) => (
                  <optgroup label={region} key={region}>
                    {list.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
          )}
          <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm font-[JetBrains_Mono,monospace]">
            {previewShip.ok
              ? <>Estimated shipping: <strong>{formatMoney(previewShip.amount, previewShip.currency)}</strong></>
              : <span className="text-[var(--muted)]">Select a company to estimate cost</span>}
          </div>
          <p className="text-xs text-[var(--muted)] mt-1">Priced per 0.5kg tier — the base rate covers the first 0.5kg, then each additional (or partial) 0.5kg is charged at the additional rate.</p>
        </div>
      )}

      <div className="flex gap-2 mt-5 sticky bottom-0 bg-[var(--bg)] pt-2">
        {!initial._isNew && (
          <Button variant="danger" onClick={() => onDelete(item.id)}><Trash2 size={15} /> Delete</Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onSave(item)} disabled={!item.name.trim()}><Check size={15} /> Save item</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Cart meta form (name + image)                                      */
/* ------------------------------------------------------------------ */

function CartMetaForm({ initial, onSave, onClose, onDelete }) {
  const [cart, setCart] = useState(initial);
  return (
    <Modal title={initial._isNew ? "New cart" : "Edit cart"} onClose={onClose}>
      <Field label="Cart name">
        <TextInput value={cart.name} onChange={(e) => setCart({ ...cart, name: e.target.value })} placeholder="e.g. Desk setup upgrade" />
      </Field>
      <Field label="Goal image URL" hint="A picture of what you're hoping to achieve">
        <TextInput value={cart.image} onChange={(e) => setCart({ ...cart, image: e.target.value })} placeholder="https://…" />
      </Field>
      {cart.image && (
        <div className="mb-3">
          <ImageThumb src={cart.image} size={120} rounded="rounded-xl" />
        </div>
      )}
      <div className="flex gap-2 mt-4">
        {!initial._isNew && <Button variant="danger" onClick={() => onDelete(cart.id)}><Trash2 size={15} /> Delete cart</Button>}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onSave(cart)} disabled={!cart.name.trim()}><Check size={15} /> Save</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Company form                                                       */
/* ------------------------------------------------------------------ */

function CompanyForm({ initial, onSave, onClose, onDelete }) {
  const [c, setC] = useState(initial);
  const set = (k, v) => setC((s) => ({ ...s, [k]: v }));
  return (
    <Modal title={initial._isNew ? "Add forwarding company" : "Edit company"} onClose={onClose}>
      <Field label="Company name">
        <TextInput value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. SpeedForward" />
      </Field>
      <Field label="Region">
        <TextInput value={c.region} onChange={(e) => set("region", e.target.value)} placeholder="e.g. Japan → Worldwide" />
      </Field>
      <Field label="Price currency">
        <CurrencySelect value={c.currency} onChange={(v) => set("currency", v)} id="cur-company" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First 0.5kg" hint="Base price">
          <TextInput type="number" step="0.01" value={c.basePrice} onChange={(e) => set("basePrice", e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Each extra 0.5kg" hint="Additional price">
          <TextInput type="number" step="0.01" value={c.additionalPrice} onChange={(e) => set("additionalPrice", e.target.value)} placeholder="0.00" />
        </Field>
      </div>
      <div className="flex gap-2 mt-4">
        {!initial._isNew && <Button variant="danger" onClick={() => onDelete(c.id)}><Trash2 size={15} /> Delete</Button>}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onSave(c)} disabled={!c.name.trim() || !c.region.trim()}><Check size={15} /> Save</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function CartsScreen({ carts, onOpen, onNew }) {
  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-[Space_Grotesk,sans-serif] text-xl font-semibold">Your carts</h1>
        <Button onClick={onNew}><Plus size={16} /> New cart</Button>
      </div>
      {carts.length === 0 ? (
        <div className="border border-dashed border-[var(--border)] rounded-xl p-10 text-center text-[var(--muted)]">
          <ShoppingCart className="mx-auto mb-3" size={28} />
          <p className="mb-3">No carts yet. Start one to plan a haul and see the real landed cost.</p>
          <Button onClick={onNew}><Plus size={16} /> Create your first cart</Button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {carts.map((cart) => (
            <button
              key={cart.id} onClick={() => onOpen(cart.id)}
              className="text-left rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden hover:border-[var(--accent)] transition-colors group"
            >
              <div className="h-28 bg-[var(--surface-2)] relative overflow-hidden">
                {cart.image ? (
                  <img src={cart.image} alt="" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = "none"; }} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[var(--muted)]">
                    <ImageIcon size={26} />
                  </div>
                )}
              </div>
              <div className="p-3">
                <div className="font-medium text-[var(--text)] truncate">{cart.name}</div>
                <div className="text-xs text-[var(--muted)] mt-0.5 flex items-center gap-1">
                  <Package size={12} /> {cart.items.length} item{cart.items.length !== 1 ? "s" : ""}
                  <ChevronRight size={14} className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CartDetailScreen({ cart, companies, rates, onBack, onEditMeta, onUpdateCart, onOpenItem, onNewItem, onDeleteItem }) {
  const totals = calcCartTotals(cart, rates, companies);

  return (
    <div className="p-4 sm:p-6 pb-28">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--text)] mb-3">
        <ArrowLeft size={15} /> All carts
      </button>

      <div className="flex items-start gap-3 mb-5">
        <button onClick={onEditMeta}>
          <ImageThumb src={cart.image} size={56} rounded="rounded-xl" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-[Space_Grotesk,sans-serif] text-xl font-semibold">{cart.name}</h1>
            <button onClick={onEditMeta} className="text-[var(--muted)] hover:text-[var(--text)]"><Pencil size={14} /></button>
          </div>
          <div className="text-xs text-[var(--muted)]">{cart.items.length} item{cart.items.length !== 1 ? "s" : ""}</div>
        </div>
        <Button onClick={onNewItem}><Plus size={16} /> Add item</Button>
      </div>

      {cart.items.length === 0 ? (
        <div className="border border-dashed border-[var(--border)] rounded-xl p-8 text-center text-[var(--muted)] mb-6">
          Add the things you're eyeing — price, tax, weight, and shipping all factor into the total.
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {totals.rows.map(({ item, rowTotal }) => (
            <button
              key={item.id} onClick={() => onOpenItem(item)}
              className="w-full flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left hover:border-[var(--accent)] transition-colors"
            >
              <ImageThumb src={item.image} />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{item.name}</div>
                <div className="text-xs text-[var(--muted)] flex items-center gap-1.5 flex-wrap">
                  {item.platform && <span>{item.platform}</span>}
                  <span className="font-[JetBrains_Mono,monospace]">{formatMoney(num(item.price) * (1 + num(item.tax) / 100), item.currency)}</span>
                  {item.shippingType === "forward" && (
                    <span className="inline-flex items-center gap-0.5 text-[var(--accent-2)]"><Truck size={11} /> forwarded</span>
                  )}
                  {item.shippingType === "free" && <span className="text-[var(--muted)]">free shipping</span>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-[JetBrains_Mono,monospace] font-medium tabular-nums">{formatMoney(rowTotal, totals.target)}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Totals panel */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-[var(--accent)]" />
        <h2 className="font-[Space_Grotesk,sans-serif] font-semibold mb-3 flex items-center gap-1.5"><Wallet size={16} /> Totals</h2>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <Field label="Card fee">
            <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
              <select
                value={cart.cardFeeType}
                onChange={(e) => onUpdateCart({ ...cart, cardFeeType: e.target.value })}
                className="bg-[var(--surface)] text-sm px-2 border-r border-[var(--border)] outline-none"
              >
                <option value="percent">%</option>
                <option value="fixed">Fixed</option>
              </select>
              <input
                type="number" step="0.01" value={cart.cardFeeValue}
                onChange={(e) => onUpdateCart({ ...cart, cardFeeValue: e.target.value })}
                className="flex-1 bg-[var(--surface)] px-2 py-2 text-sm outline-none min-w-0"
                placeholder="0"
              />
            </div>
          </Field>
          {cart.cardFeeType === "fixed" && (
            <Field label="Fee currency">
              <CurrencySelect value={cart.cardFeeCurrency} onChange={(v) => onUpdateCart({ ...cart, cardFeeCurrency: v })} id="cur-fee" />
            </Field>
          )}
          <Field label="Total in">
            <CurrencySelect value={cart.totalCurrency} onChange={(v) => onUpdateCart({ ...cart, totalCurrency: v })} id="cur-total" />
          </Field>
        </div>

        {totals.missingCompany && (
          <div className="flex items-center gap-2 text-xs text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mb-2">
            <AlertTriangle size={14} /> An item is set to forward but has no company selected.
          </div>
        )}
        {totals.missingRate && (
          <div className="flex items-center gap-2 text-xs text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mb-2">
            <AlertTriangle size={14} /> Missing exchange rates for a currency used here — refresh forex in Settings.
          </div>
        )}

        <div className="border-t border-dashed border-[var(--border)] pt-3 mt-1 space-y-1 text-sm font-[JetBrains_Mono,monospace]">
          <div className="flex justify-between"><span className="text-[var(--muted)]">Subtotal</span><span>{formatMoney(totals.subtotal, totals.target)}</span></div>
          <div className="flex justify-between"><span className="text-[var(--muted)]">Card fee</span><span>{formatMoney(totals.feeAmount, totals.target)}</span></div>
          <div className="flex justify-between text-lg font-semibold pt-1"><span className="font-[Space_Grotesk,sans-serif]">Total</span><span className="tabular-nums">{formatMoney(totals.total, totals.target)}</span></div>
        </div>
      </div>
    </div>
  );
}

function CompaniesScreen({ companies, onNew, onEdit }) {
  const regions = useMemo(() => {
    const map = {};
    companies.forEach((c) => {
      const r = c.region || "Other";
      map[r] = map[r] || [];
      map[r].push(c);
    });
    return map;
  }, [companies]);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-[Space_Grotesk,sans-serif] text-xl font-semibold">Forwarding companies</h1>
        <Button onClick={onNew}><Plus size={16} /> Add company</Button>
      </div>
      <p className="text-sm text-[var(--muted)] mb-4">Store each company's per-region rate — the base price for the first 0.5kg, and the price for every additional 0.5kg. Item shipping is calculated from these automatically.</p>

      {companies.length === 0 ? (
        <div className="border border-dashed border-[var(--border)] rounded-xl p-8 text-center text-[var(--muted)]">
          <Building2 className="mx-auto mb-3" size={26} />
          No forwarding companies yet.
        </div>
      ) : (
        Object.entries(regions).map(([region, list]) => (
          <div key={region} className="mb-5">
            <h3 className="text-xs uppercase tracking-wider text-[var(--muted)] font-medium mb-2">{region}</h3>
            <div className="space-y-2">
              {list.map((c) => (
                <button
                  key={c.id} onClick={() => onEdit(c)}
                  className="w-full flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left hover:border-[var(--accent)] transition-colors"
                >
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-[var(--muted)] font-[JetBrains_Mono,monospace]">
                      {formatMoney(num(c.basePrice), c.currency)} / first 0.5kg · +{formatMoney(num(c.additionalPrice), c.currency)} per extra 0.5kg
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-[var(--muted)]" />
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SettingsScreen({ settings, rates, onUpdateSettings, onRefresh, refreshing, refreshError, theme, onToggleTheme }) {
  const [keyDraft, setKeyDraft] = useState(settings.apiKey);
  useEffect(() => setKeyDraft(settings.apiKey), [settings.apiKey]);

  const cooldownLeft = rates && settings.lastRefresh
    ? Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - settings.lastRefresh))
    : 0;

  return (
    <div className="p-4 sm:p-6 max-w-lg">
      <h1 className="font-[Space_Grotesk,sans-serif] text-xl font-semibold mb-4">Settings</h1>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 mb-4">
        <h2 className="font-medium mb-1 flex items-center gap-1.5"><Sun size={15} /> Appearance</h2>
        <p className="text-xs text-[var(--muted)] mb-3">Switch between light and dark mode.</p>
        <Button variant="subtle" onClick={onToggleTheme}>
          {theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
          {theme === "dark" ? "Dark mode" : "Light mode"} — tap to switch
        </Button>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="font-medium mb-1">Open Exchange Rates</h2>
        <p className="text-xs text-[var(--muted)] mb-3">Add your App ID to enable live currency conversion across items, carts, and companies.</p>
        <Field label="API key">
          <TextInput
            value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={() => onUpdateSettings({ ...settings, apiKey: keyDraft.trim() })}
            placeholder="Your Open Exchange Rates App ID" type="text"
          />
        </Field>

        <div className="flex items-center gap-2 mt-2">
          <Button onClick={onRefresh} disabled={refreshing || !settings.apiKey.trim() || cooldownLeft > 0}>
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh forex rates"}
          </Button>
        </div>

        <div className="text-xs text-[var(--muted)] mt-2 space-y-0.5">
          {rates?.timestamp ? (
            <div>Last updated: {new Date(rates.timestamp).toLocaleString()} · base {rates.base} · {Object.keys(rates.rates || {}).length} currencies</div>
          ) : (
            <div>No rates fetched yet.</div>
          )}
          {cooldownLeft > 0 && (
            <div>You can refresh again in {Math.ceil(cooldownLeft / 60000)} min — this keeps you well under the free API tier's call limits.</div>
          )}
          {refreshError && <div className="text-[var(--danger)]">{refreshError}</div>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const PALETTES = {
  light: {
    bg: "#FAFAF6", surface: "#FFFFFF", "surface-2": "#F1EFE7", border: "#E3E0D5",
    text: "#211F1B", muted: "#7A7466", accent: "#276E6A", "accent-2": "#B5732F", danger: "#B4432F"
  },
  dark: {
    bg: "#15181A", surface: "#1D2124", "surface-2": "#262B2E", border: "#31373A",
    text: "#ECE9E1", muted: "#8F958F", accent: "#54B7AC", "accent-2": "#E0995E", danger: "#E27159"
  }
};

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState("carts"); // carts | cart | companies | settings
  const [activeCartId, setActiveCartId] = useState(null);
  const [itemModal, setItemModal] = useState(null); // item object or null
  const [cartModal, setCartModal] = useState(null);
  const [companyModal, setCompanyModal] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const saveTimer = useRef(null);

  // Load
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setData({ ...defaultData(), ...parsed, settings: { ...defaultData().settings, ...(parsed.settings || {}) } });
        } else {
          setData(defaultData());
        }
      } catch (e) {
        setData(defaultData());
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Debounced save
  useEffect(() => {
    if (!data) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      window.storage.set(STORAGE_KEY, JSON.stringify(data), false).catch(() => {});
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [data]);

  const theme = data?.settings?.theme || "light";

  useEffect(() => {
    if (!data) return;
    const palette = PALETTES[theme];
    // no-op: applied via inline CSS vars on root wrapper
  }, [theme, data]);

  if (loading || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAFAF6] text-[#7A7466]">
        <RefreshCw className="animate-spin mr-2" size={18} /> Loading ShipLedger…
      </div>
    );
  }

  const palette = PALETTES[theme];
  const cssVars = Object.fromEntries(Object.entries(palette).map(([k, v]) => [`--${k}`, v]));

  const activeCart = data.carts.find((c) => c.id === activeCartId) || null;

  function updateCart(updated) {
    setData((d) => ({ ...d, carts: d.carts.map((c) => (c.id === updated.id ? updated : c)) }));
  }

  function saveCartMeta(cart) {
    setData((d) => {
      const exists = d.carts.some((c) => c.id === cart.id);
      const clean = { ...cart };
      delete clean._isNew;
      return { ...d, carts: exists ? d.carts.map((c) => (c.id === cart.id ? clean : c)) : [...d.carts, clean] };
    });
    setCartModal(null);
    setActiveCartId(cart.id);
    setScreen("cart");
  }

  function deleteCart(id) {
    setData((d) => ({ ...d, carts: d.carts.filter((c) => c.id !== id) }));
    setCartModal(null);
    setScreen("carts");
    setActiveCartId(null);
  }

  function saveItem(item) {
    if (!activeCart) return;
    const clean = { ...item };
    delete clean._isNew;
    const exists = activeCart.items.some((i) => i.id === item.id);
    const items = exists ? activeCart.items.map((i) => (i.id === item.id ? clean : i)) : [...activeCart.items, clean];
    updateCart({ ...activeCart, items });
    setItemModal(null);
  }

  function deleteItem(id) {
    if (!activeCart) return;
    updateCart({ ...activeCart, items: activeCart.items.filter((i) => i.id !== id) });
    setItemModal(null);
  }

  function saveCompany(company) {
    setData((d) => {
      const exists = d.companies.some((c) => c.id === company.id);
      const clean = { ...company };
      delete clean._isNew;
      return { ...d, companies: exists ? d.companies.map((c) => (c.id === company.id ? clean : c)) : [...d.companies, clean] };
    });
    setCompanyModal(null);
  }

  function deleteCompany(id) {
    setData((d) => ({ ...d, companies: d.companies.filter((c) => c.id !== id) }));
    setCompanyModal(null);
  }

  async function refreshForex() {
    const key = data.settings.apiKey.trim();
    if (!key) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(key)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.description || `Request failed (${res.status})`);
      }
      const json = await res.json();
      const newRates = { base: json.base || "USD", rates: json.rates || {}, timestamp: Date.now() };
      setData((d) => ({ ...d, rates: newRates, settings: { ...d.settings, lastRefresh: Date.now() } }));
    } catch (e) {
      setRefreshError(e.message || "Could not fetch rates. Check your API key and connection.");
    } finally {
      setRefreshing(false);
    }
  }

  function toggleTheme() {
    setData((d) => ({ ...d, settings: { ...d.settings, theme: d.settings.theme === "dark" ? "light" : "dark" } }));
  }

  return (
    <div style={cssVars} className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { font-family: 'Inter', sans-serif; }
        ::selection { background: var(--accent); color: white; }
      `}</style>

      {/* Top bar */}
      <div className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
        <div className="flex items-center gap-2 px-4 sm:px-6 h-14">
          <div className="font-[Space_Grotesk,sans-serif] font-bold text-[15px] tracking-tight flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)]" />
            ShipLedger
          </div>
          <div className="flex-1" />
          <nav className="flex items-center gap-1">
            <button
              onClick={() => { setScreen("carts"); setActiveCartId(null); }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${screen === "carts" || screen === "cart" ? "bg-[var(--surface-2)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}
            >Carts</button>
            <button
              onClick={() => setScreen("companies")}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${screen === "companies" ? "bg-[var(--surface-2)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}
            >Companies</button>
            <button
              onClick={() => setScreen("settings")}
              className={`p-2 rounded-lg ${screen === "settings" ? "bg-[var(--surface-2)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}
              aria-label="Settings"
            ><SettingsIcon size={17} /></button>
            <button onClick={toggleTheme} className="p-2 rounded-lg text-[var(--muted)] hover:text-[var(--text)]" aria-label="Toggle theme">
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </nav>
        </div>
      </div>

      {screen === "carts" && (
        <CartsScreen
          carts={data.carts}
          onOpen={(id) => { setActiveCartId(id); setScreen("cart"); }}
          onNew={() => setCartModal({ ...emptyCart(), _isNew: true })}
        />
      )}

      {screen === "cart" && activeCart && (
        <CartDetailScreen
          cart={activeCart}
          companies={data.companies}
          rates={data.rates}
          onBack={() => { setScreen("carts"); setActiveCartId(null); }}
          onEditMeta={() => setCartModal(activeCart)}
          onUpdateCart={updateCart}
          onOpenItem={(item) => setItemModal(item)}
          onNewItem={() => setItemModal({ ...emptyItem(), _isNew: true })}
        />
      )}

      {screen === "companies" && (
        <CompaniesScreen
          companies={data.companies}
          onNew={() => setCompanyModal({ ...emptyCompany(), _isNew: true })}
          onEdit={(c) => setCompanyModal(c)}
        />
      )}

      {screen === "settings" && (
        <SettingsScreen
          settings={data.settings}
          rates={data.rates}
          onUpdateSettings={(s) => setData((d) => ({ ...d, settings: s }))}
          onRefresh={refreshForex}
          refreshing={refreshing}
          refreshError={refreshError}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      )}

      {itemModal && (
        <ItemForm
          initial={itemModal}
          companies={data.companies}
          onSave={saveItem}
          onClose={() => setItemModal(null)}
          onDelete={deleteItem}
        />
      )}

      {cartModal && (
        <CartMetaForm
          initial={cartModal}
          onSave={saveCartMeta}
          onClose={() => setCartModal(null)}
          onDelete={deleteCart}
        />
      )}

      {companyModal && (
        <CompanyForm
          initial={companyModal}
          onSave={saveCompany}
          onClose={() => setCompanyModal(null)}
          onDelete={deleteCompany}
        />
      )}
    </div>
  );
}

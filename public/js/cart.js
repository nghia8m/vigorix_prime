/* ===========================================================================
   Vigorix Prime — client-side cart (phase 2)
   ---------------------------------------------------------------------------
   PHASE 2 SCOPE: cart only. No checkout page, no payment gateway, no server
   endpoint. The checkout button is deliberately inert.

   WHAT IS PERSISTED
     localStorage holds ONLY [{ productSlug, variantId, qty }].
     Name, price, image, variant label and stock are looked up from
     /shop/catalog.json on every render. A price edited in the admin is
     therefore reflected in an existing cart, instead of the cart holding a
     stale copy that a checkout would later reject.

   LINE IDENTITY
     productSlug + "::" + variantId. Two sizes of the same brace are two lines.
     Line price = product price + that variant's priceDelta.

   MONEY
     Integer cents everywhere. Formatting happens only at display time.
   =========================================================================== */
(function () {
  "use strict";

  var CATALOG_URL = "/shop/catalog.json";
  var KEY_SEP = "::";

  /* Fallback config, replaced by the real one as soon as the catalogue loads.
     It exists so the cart still behaves sanely if the fetch fails. */
  var config = {
    MIN_ORDER_QTY: 1,
    MAX_QTY_PER_LINE: 99,
    STORAGE_KEY: "vp.cart.v1",
  };

  /* Shipping policy — owned by Admin → Site Settings (src/data/site.json), not
     by this file. While `enabled` is false the cart shows `displayNote` and no
     number at all, rather than inventing a rate nobody has agreed to. */
  var shippingCfg = {
    enabled: false,
    displayNote: "Shipping calculated at checkout",
    currency: "USD",
    freeOverCents: 0,
    rates: [],
  };

  var catalog = null; // { slug: product }
  var catalogState = "idle"; // idle | loading | ready | error
  var items = []; // [{ productSlug, variantId, qty }]
  var storageWritable = true; // false in private mode / when the quota is full

  // ---------------------------------------------------------------- storage --

  /** Accepts only well-formed entries; anything else is dropped silently. */
  function sanitise(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (!it || typeof it !== "object") continue;
      if (typeof it.productSlug !== "string" || !it.productSlug) continue;
      if (typeof it.variantId !== "string") continue;
      var qty = normaliseQty(it.qty);
      if (qty === null || qty < 1) continue;
      var key = it.productSlug + KEY_SEP + it.variantId;
      if (seen[key] !== undefined) {
        // Two entries for the same line (hand-edited storage): merge them.
        out[seen[key]].qty = clampQty(out[seen[key]].qty + qty);
        continue;
      }
      seen[key] = out.length;
      out.push({ productSlug: it.productSlug, variantId: it.variantId, qty: qty });
    }
    return out;
  }

  function load() {
    var raw;
    try {
      raw = window.localStorage.getItem(config.STORAGE_KEY);
    } catch (e) {
      storageWritable = false;
      return [];
    }
    if (!raw) return [];
    try {
      return sanitise(JSON.parse(raw));
    } catch (e) {
      // Corrupt JSON: start clean rather than throwing on every page load.
      try { window.localStorage.removeItem(config.STORAGE_KEY); } catch (e2) {}
      return [];
    }
  }

  function persist() {
    try {
      window.localStorage.setItem(config.STORAGE_KEY, JSON.stringify(items));
      storageWritable = true;
    } catch (e) {
      // Private mode, quota exceeded, storage disabled. The cart keeps working
      // for this session from memory; it just will not survive a reload.
      storageWritable = false;
    }
  }

  // ------------------------------------------------------------- quantities --

  /** null = not a usable number at all. Fractions floor, so 1.5 -> 1. */
  function normaliseQty(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (typeof n !== "number" || !isFinite(n)) return null;
    return Math.floor(n);
  }

  function clampQty(n) {
    return Math.max(1, Math.min(config.MAX_QTY_PER_LINE, n));
  }

  // ---------------------------------------------------------------- catalog --

  function loadCatalog() {
    if (catalogState === "ready" || catalogState === "loading") return;
    catalogState = "loading";
    fetch(CATALOG_URL, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("catalog " + r.status);
        return r.json();
      })
      .then(function (data) {
        catalog = data.products || {};
        if (data.config) config = data.config;
        if (data.shipping) shippingCfg = data.shipping;
        catalogState = "ready";
        // Storage may hold products that no longer exist; drop them now.
        var before = items.length;
        items = items.filter(function (it) { return !!resolve(it); });
        if (items.length !== before) persist();
        emit("cart:change");
      })
      .catch(function () {
        catalogState = "error";
        emit("cart:change");
      });
  }

  /** Resolves a stored item against the catalogue, or null if it is gone. */
  function resolve(item) {
    if (!catalog) return null;
    var product = catalog[item.productSlug];
    if (!product) return null;

    var variant = null;
    if (item.variantId) {
      for (var i = 0; i < product.variants.length; i++) {
        if (product.variants[i].id === item.variantId) { variant = product.variants[i]; break; }
      }
      if (!variant) return null; // variant deleted from the collection
    } else if (product.variants.length) {
      return null; // product gained variants since this line was stored
    }

    var unitCents = product.priceCents + (variant ? variant.priceDeltaCents : 0);
    return {
      key: item.productSlug + KEY_SEP + item.variantId,
      productSlug: item.productSlug,
      variantId: item.variantId,
      qty: item.qty,
      name: product.name,
      path: product.path,
      variantLabel: variant ? variant.label : "",
      variantType: product.variantType || "",
      sku: variant ? variant.sku : "",
      image: (variant && variant.image) || product.image,
      imageAlt: product.imageAlt,
      stock: variant ? variant.stock : product.stock,
      unitCents: unitCents,
      lineCents: unitCents * item.qty,
    };
  }

  function indexOfKey(key) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].productSlug + KEY_SEP + items[i].variantId === key) return i;
    }
    return -1;
  }

  // ----------------------------------------------------------------- events --

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    if (name !== "cart:change") window.dispatchEvent(new CustomEvent("cart:change", { detail: detail || {} }));
  }

  // -------------------------------------------------------------- money math --

  function subtotal() {
    var sum = 0;
    var ls = lines();
    for (var i = 0; i < ls.length; i++) sum += ls[i].lineCents;
    return sum;
  }

  /**
   * Shipping in cents, or NULL when it cannot be worked out yet (policy is off).
   * Null is not zero: "we don't know" and "it's free" must not look the same.
   *
   * Free shipping applies STRICTLY ABOVE freeOverCents. With 5000, a $50.00
   * order still pays postage; $50.01 does not.
   */
  function shipping() {
    var sub = subtotal();
    if (sub <= 0) return 0;
    if (!shippingCfg.enabled) return null;
    if (sub > shippingCfg.freeOverCents) return 0;
    var rate = shippingCfg.rates && shippingCfg.rates[0];
    return rate ? rate.flatCents : 0;
  }

  /** The line of text shown when shipping cannot be calculated. */
  function shippingNote() {
    return shippingCfg.displayNote;
  }

  /** Cents still needed to cross the free-shipping line, or 0 when not applicable. */
  function toFreeShipping() {
    if (!shippingCfg.enabled) return 0;
    var sub = subtotal();
    if (sub <= 0 || sub > shippingCfg.freeOverCents) return 0;
    // +1 cent because the threshold is exclusive.
    return shippingCfg.freeOverCents - sub + 1;
  }

  /** Subtotal plus shipping. Unknown shipping counts as 0 and the UI says so. */
  function total() {
    return subtotal() + (shipping() || 0);
  }

  function formatMoney(cents) {
    var amount = cents / 100;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: shippingCfg.currency || "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (e) {
      return "$" + amount.toFixed(2);
    }
  }

  // -------------------------------------------------------------- public API --

  function lines() {
    if (!catalog) return [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var line = resolve(items[i]);
      if (line) out.push(line);
    }
    return out;
  }

  function totalQty() {
    // Deliberately derived from storage, not from lines(): the header badge is
    // then correct on first paint, before the catalogue has finished loading.
    var n = 0;
    for (var i = 0; i < items.length; i++) n += items[i].qty;
    return n;
  }

  function add(productSlug, variantId, qty) {
    variantId = variantId || "";
    var wanted = normaliseQty(qty === undefined ? 1 : qty);
    if (wanted === null || wanted < 1) {
      return { ok: false, reason: "invalid-qty", message: "Quantity must be a whole number of 1 or more." };
    }
    if (catalogState !== "ready") {
      return { ok: false, reason: "not-ready", message: "The shop is still loading. Try again in a moment." };
    }

    var probe = resolve({ productSlug: productSlug, variantId: variantId, qty: 1 });
    if (!probe) {
      return { ok: false, reason: "unknown", message: "That product is no longer available." };
    }
    if (probe.stock === "out") {
      return {
        ok: false,
        reason: "out-of-stock",
        message: probe.variantLabel
          ? probe.name + " (" + probe.variantLabel + ") is out of stock."
          : probe.name + " is out of stock.",
      };
    }

    var key = productSlug + KEY_SEP + variantId;
    var idx = indexOfKey(key);
    if (idx === -1) {
      items.push({ productSlug: productSlug, variantId: variantId, qty: clampQty(wanted) });
    } else {
      items[idx].qty = clampQty(items[idx].qty + wanted);
    }
    persist();
    emit("cart:add", { key: key, qty: wanted });
    return { ok: true, key: key };
  }

  function setQty(lineKey, qty) {
    var idx = indexOfKey(lineKey);
    if (idx === -1) return { ok: false, reason: "unknown" };

    var n = normaliseQty(qty);
    if (n === null) return { ok: false, reason: "invalid-qty" }; // "abc" -> ignored
    if (n < 1) return remove(lineKey); // 0 and negatives remove the line

    items[idx].qty = clampQty(n);
    persist();
    emit("cart:change", { key: lineKey });
    return { ok: true, qty: items[idx].qty };
  }

  function remove(lineKey) {
    var idx = indexOfKey(lineKey);
    if (idx === -1) return { ok: false, reason: "unknown" };
    items.splice(idx, 1);
    persist();
    emit("cart:remove", { key: lineKey });
    return { ok: true };
  }

  function clear() {
    items = [];
    persist();
    emit("cart:change", { cleared: true });
    return { ok: true };
  }

  function meetsMinOrder() {
    return totalQty() >= config.MIN_ORDER_QTY;
  }

  function shortToMinOrder() {
    return Math.max(0, config.MIN_ORDER_QTY - totalQty());
  }

  function hasOutOfStock() {
    var ls = lines();
    for (var i = 0; i < ls.length; i++) if (ls[i].stock === "out") return true;
    return false;
  }

  // ------------------------------------------------------------ other tabs --

  window.addEventListener("storage", function (e) {
    if (e.key !== config.STORAGE_KEY) return;
    items = load();
    emit("cart:change", { external: true });
  });

  items = load();
  loadCatalog();

  window.vpCart = {
    add: add,
    setQty: setQty,
    remove: remove,
    clear: clear,
    lines: lines,
    totalQty: totalQty,
    subtotal: subtotal,
    shipping: shipping,
    total: total,
    shippingNote: shippingNote,
    toFreeShipping: toFreeShipping,
    meetsMinOrder: meetsMinOrder,
    shortToMinOrder: shortToMinOrder,
    hasOutOfStock: hasOutOfStock,
    formatMoney: formatMoney,
    config: function () { return config; },
    shippingConfig: function () { return shippingCfg; },
    state: function () {
      return { catalog: catalogState, storageWritable: storageWritable, items: items.slice() };
    },
    reload: function () { items = load(); emit("cart:change"); },
  };
})();

/* ===========================================================================
   Drawer + header badge
   =========================================================================== */
(function () {
  "use strict";

  var drawer, list, empty, badge, openers, closeBtn, foot, warn, checkoutBtn, notice;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function money(cents) { return window.vpCart.formatMoney(cents); }

  function renderBadge() {
    var n = window.vpCart.totalQty();
    $$("[data-cart-badge]").forEach(function (el) {
      el.textContent = String(n);
      el.hidden = n === 0;
    });
    $$("[data-cart-count-label]").forEach(function (el) {
      el.textContent = n === 1 ? "1 item in cart" : n + " items in cart";
    });
  }

  function lineNode(line) {
    var li = document.createElement("li");
    li.className = "cart-line" + (line.stock === "out" ? " is-out" : "");
    li.setAttribute("data-line", line.key);

    var img = document.createElement("img");
    img.className = "cart-line-img";
    img.src = line.image;
    img.alt = "";
    img.width = 64;
    img.height = 64;
    img.loading = "lazy";

    var body = document.createElement("div");
    body.className = "cart-line-body";

    var title = document.createElement("a");
    title.className = "cart-line-name";
    title.href = line.path;
    title.textContent = line.name;
    body.appendChild(title);

    if (line.variantLabel) {
      var v = document.createElement("p");
      v.className = "cart-line-variant";
      v.textContent = (line.variantType ? line.variantType + ": " : "") + line.variantLabel;
      body.appendChild(v);
    }

    if (line.stock === "out") {
      var flag = document.createElement("p");
      flag.className = "cart-line-flag";
      flag.textContent = "Out of stock — remove it to continue";
      body.appendChild(flag);
    } else if (line.stock === "preorder") {
      var pre = document.createElement("p");
      pre.className = "cart-line-pre";
      pre.textContent = "Pre-order";
      body.appendChild(pre);
    }

    var controls = document.createElement("div");
    controls.className = "cart-line-controls";

    var label = document.createElement("label");
    label.className = "sr-only";
    label.setAttribute("for", "qty-" + line.key.replace(/[^a-z0-9]/gi, "-"));
    label.textContent = "Quantity for " + line.name + (line.variantLabel ? " " + line.variantLabel : "");

    var qty = document.createElement("input");
    qty.type = "number";
    qty.className = "cart-qty";
    qty.id = "qty-" + line.key.replace(/[^a-z0-9]/gi, "-");
    qty.min = "1";
    qty.max = String(window.vpCart.config().MAX_QTY_PER_LINE);
    qty.step = "1";
    qty.inputMode = "numeric";
    qty.value = String(line.qty);
    qty.setAttribute("data-qty-for", line.key);

    var price = document.createElement("span");
    price.className = "cart-line-price";
    price.textContent = money(line.lineCents);

    var del = document.createElement("button");
    del.type = "button";
    del.className = "cart-line-remove";
    del.setAttribute("data-remove", line.key);
    del.setAttribute("aria-label", "Remove " + line.name + (line.variantLabel ? " " + line.variantLabel : "") + " from cart");
    del.textContent = "Remove";

    controls.appendChild(label);
    controls.appendChild(qty);
    controls.appendChild(price);
    controls.appendChild(del);
    body.appendChild(controls);

    li.appendChild(img);
    li.appendChild(body);
    return li;
  }

  function render() {
    renderBadge();
    if (!drawer) return;

    var cart = window.vpCart;
    var state = cart.state();
    var ls = cart.lines();

    // Storage unavailable (private browsing / quota) — say so rather than
    // letting the cart look like it silently forgot everything.
    if (notice) {
      var storageProblem = !state.storageWritable;
      var catalogProblem = state.catalog === "error";
      notice.hidden = !(storageProblem || catalogProblem);
      notice.textContent = catalogProblem
        ? "We could not load product details just now. Your items are safe — please refresh."
        : "This browser is blocking storage, so your cart will not be kept after you close this tab.";
    }

    list.innerHTML = "";
    if (ls.length === 0) {
      empty.hidden = false;
      list.hidden = true;
      foot.hidden = true;
      return;
    }
    empty.hidden = true;
    list.hidden = false;
    foot.hidden = false;
    ls.forEach(function (line) { list.appendChild(lineNode(line)); });

    $("[data-cart-subtotal]").textContent = money(cart.subtotal());

    // null = policy not set yet: show the note, never a number.
    var ship = cart.shipping();
    var shipCell = $("[data-cart-shipping]");
    shipCell.textContent = ship === null ? cart.shippingNote() : ship === 0 ? "Free" : money(ship);
    shipCell.classList.toggle("is-note", ship === null);

    $("[data-cart-total]").textContent = money(cart.total());
    var totalNote = $("[data-cart-total-note]");
    if (totalNote) totalNote.hidden = ship !== null;

    var away = cart.toFreeShipping();
    var nudge = $("[data-cart-freeship]");
    if (nudge) {
      nudge.hidden = away <= 0;
      if (away > 0) nudge.textContent = "Spend " + money(away) + " more for free shipping.";
    }

    var cfg = cart.config();

    // Minimum-order branch. With MIN_ORDER_QTY = 1 this never shows for a
    // non-empty cart; it is exercised by temporarily raising the setting.
    var short = cart.shortToMinOrder();
    warn.hidden = short === 0;
    if (short > 0) {
      warn.textContent = "Add " + short + " more item" + (short === 1 ? "" : "s") +
        " to reach the " + cfg.MIN_ORDER_QTY + "-item minimum order.";
    }

    var blocked = !cart.meetsMinOrder() || cart.hasOutOfStock();
    checkoutBtn.disabled = blocked;
    checkoutBtn.setAttribute("aria-disabled", blocked ? "true" : "false");
  }

  // ------------------------------------------------------------ open / close --

  function open() {
    if (!drawer || drawer.open) return;
    drawer.showModal(); // native <dialog>: focus moves in, Esc closes, focus is restored
    document.body.classList.add("cart-open");
    render();
  }

  function close() {
    if (!drawer || !drawer.open) return;
    drawer.close();
    // Also unlocked by the `close` event below; done here too so the page can
    // never be left unscrollable if that event is missed.
    document.body.classList.remove("cart-open");
  }

  function wire() {
    drawer = $("[data-cart-drawer]");
    if (!drawer) return;
    list = $("[data-cart-list]", drawer);
    empty = $("[data-cart-empty]", drawer);
    foot = $("[data-cart-foot]", drawer);
    warn = $("[data-cart-min-warning]", drawer);
    notice = $("[data-cart-notice]", drawer);
    checkoutBtn = $("[data-cart-checkout]", drawer);
    closeBtn = $("[data-cart-close]", drawer);

    $$("[data-cart-open]").forEach(function (btn) {
      btn.addEventListener("click", function (e) { e.preventDefault(); open(); });
    });
    if (closeBtn) closeBtn.addEventListener("click", close);

    // Takes the shopper to the checkout page. render() decides whether the
    // button is usable at all (empty cart, below the minimum, or a line that
    // went out of stock), so this only has to handle the allowed case.
    if (checkoutBtn) {
      checkoutBtn.addEventListener("click", function () {
        if (checkoutBtn.disabled) return;
        close();
        window.location.href = "/checkout";
      });
    }

    // Click on the backdrop (the dialog element itself) dismisses.
    drawer.addEventListener("click", function (e) { if (e.target === drawer) close(); });
    drawer.addEventListener("close", function () { document.body.classList.remove("cart-open"); });

    drawer.addEventListener("input", function (e) {
      var key = e.target.getAttribute && e.target.getAttribute("data-qty-for");
      if (!key) return;
      var raw = e.target.value;
      if (raw === "") return; // mid-typing; wait for change
      window.vpCart.setQty(key, raw);
    });
    drawer.addEventListener("change", function (e) {
      var key = e.target.getAttribute && e.target.getAttribute("data-qty-for");
      if (!key) return;
      window.vpCart.setQty(key, e.target.value === "" ? 1 : e.target.value);
      render();
    });
    drawer.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-remove]");
      if (!btn) return;
      window.vpCart.remove(btn.getAttribute("data-remove"));
    });

    // Only re-render on store changes. Opening the drawer is a UI decision made
    // by whatever the shopper clicked — the store never opens it. Otherwise a
    // cross-tab change, or any programmatic add, would pop the drawer open
    // unexpectedly.
    window.addEventListener("cart:change", render);

    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  window.vpCartUI = { open: open, close: close, render: render };
})();

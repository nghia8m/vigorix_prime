/* ===========================================================================
   Vigorix Prime — checkout (phase 2)
   ---------------------------------------------------------------------------
   SCOPE: layout, validation and the draft order object. No payment gateway, no
   server endpoint, no card data. Phase 3 renders payment buttons into the
   #payment-buttons container this file leaves alone.

   ⚠ THE VALIDATION BELOW IS FOR USABILITY, NOT SECURITY. It runs in the
   browser, so anyone can bypass it. Phase 3 MUST re-check every field on the
   server before an order is accepted.
   =========================================================================== */
(function () {
  "use strict";

  var ORDER_KEY = "vp.order.draft";

  var form, lines, sumLines, empty, grid, devout, devoutJson, submitBtn;
  var rules = { regionLabels: {}, regionRequired: [], noPostalCode: [], defaultRegionLabel: "Region" };
  var submitting = false; // re-entrancy guard for a single click burst
  var lastSubmitAt = 0; // timestamp of the last accepted submit
  var DOUBLE_CLICK_MS = 1200; // repeats inside this window are the same action
  var currentOrder = null; // the draft already built, if any

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  var money = function (c) { return window.vpCart.formatMoney(c); };

  // ------------------------------------------------------------- rendering --

  function lineRow(line, forSummary) {
    var li = document.createElement("li");
    li.className = forSummary ? "co-sum-line" : "co-line";
    if (line.stock === "out") li.className += " is-out";
    li.setAttribute("data-line", line.key);

    var img = document.createElement("img");
    img.src = line.image;
    img.alt = "";
    img.width = forSummary ? 52 : 68;
    img.height = forSummary ? 52 : 68;
    img.loading = "lazy";
    img.className = "co-line-img";

    var body = document.createElement("div");
    body.className = "co-line-body";

    var name = document.createElement("p");
    name.className = "co-line-name";
    name.textContent = line.name;
    body.appendChild(name);

    if (line.variantLabel) {
      var v = document.createElement("p");
      v.className = "co-line-variant";
      v.textContent = (line.variantType ? line.variantType + ": " : "") + line.variantLabel;
      body.appendChild(v);
    }

    if (line.stock === "out") {
      var flag = document.createElement("p");
      flag.className = "co-line-flag";
      flag.textContent = "Out of stock — remove it to continue";
      body.appendChild(flag);
    }

    if (forSummary) {
      var q = document.createElement("span");
      q.className = "co-qty-badge";
      q.textContent = String(line.qty);
      img.setAttribute("data-qty", String(line.qty));
      var wrap = document.createElement("div");
      wrap.className = "co-sum-thumb";
      wrap.appendChild(img);
      wrap.appendChild(q);
      li.appendChild(wrap);
      li.appendChild(body);
      var p = document.createElement("span");
      p.className = "co-line-price";
      p.textContent = money(line.lineCents);
      li.appendChild(p);
      return li;
    }

    var controls = document.createElement("div");
    controls.className = "co-line-controls";

    var label = document.createElement("label");
    var id = "co-qty-" + line.key.replace(/[^a-z0-9]/gi, "-");
    label.setAttribute("for", id);
    label.className = "sr-only";
    label.textContent = "Quantity for " + line.name + (line.variantLabel ? " " + line.variantLabel : "");

    var qty = document.createElement("input");
    qty.type = "number";
    qty.id = id;
    qty.className = "co-qty";
    qty.min = "1";
    qty.max = String(window.vpCart.config().MAX_QTY_PER_LINE);
    qty.step = "1";
    qty.inputMode = "numeric";
    qty.value = String(line.qty);
    qty.setAttribute("data-co-qty-for", line.key);

    var price = document.createElement("span");
    price.className = "co-line-price";
    price.textContent = money(line.lineCents);

    var del = document.createElement("button");
    del.type = "button";
    del.className = "co-line-remove";
    del.setAttribute("data-co-remove", line.key);
    del.setAttribute("aria-label", "Remove " + line.name + (line.variantLabel ? " " + line.variantLabel : ""));
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

  /* One postage model, so there is nothing to pick. This renders a plain
     statement of what the order is being charged and why, instead of a radio
     group with a single option in it. */
  function renderShippingMethods() {
    var host = $("[data-co-shipping-methods]");
    if (!host) return;
    var cart = window.vpCart;
    var cfg = cart.shippingConfig();
    host.innerHTML = "";

    var note = document.createElement("p");
    note.className = "co-ship-note";
    var sub = document.createElement("p");
    sub.className = "co-hint";

    if (!cfg.enabled) {
      note.textContent = "Free shipping";
      sub.textContent = "Postage is included in the prices shown.";
    } else {
      var blocks = cart.shippingBlocks();
      note.textContent = money(cart.shipping());
      sub.textContent =
        cart.shippingNote() + " — " + cart.totalQty() + " items, " +
        blocks + (blocks === 1 ? " charge." : " charges.");
    }
    host.appendChild(note);
    host.appendChild(sub);
  }

  /** Shipping for THIS checkout, in cents. Always a number; 0 means free. */
  function shippingCents() {
    return window.vpCart.shipping();
  }

  function render() {
    var cart = window.vpCart;
    var ls = cart.lines();

    if (ls.length === 0) {
      grid.hidden = true;
      empty.hidden = false;
      // Redirected rather than left on a dead page, but only after the message
      // has had a moment to be read.
      if (!window.__coRedirecting) {
        window.__coRedirecting = true;
        setTimeout(function () { window.location.replace("/shop"); }, 3000);
      }
      return;
    }
    empty.hidden = true;
    grid.hidden = false;

    lines.innerHTML = "";
    sumLines.innerHTML = "";
    ls.forEach(function (l) {
      lines.appendChild(lineRow(l, false));
      sumLines.appendChild(lineRow(l, true));
    });

    var warn = $("[data-co-stock-warning]");
    var outLines = ls.filter(function (l) { return l.stock === "out"; });
    warn.hidden = outLines.length === 0;
    if (outLines.length) {
      warn.textContent = outLines.length === 1
        ? "“" + outLines[0].name + (outLines[0].variantLabel ? " (" + outLines[0].variantLabel + ")" : "") +
          "” went out of stock. Remove it to continue."
        : outLines.length + " items in your cart went out of stock. Remove them to continue.";
    }

    renderShippingMethods();

    var sub = cart.subtotal();
    var ship = shippingCents();
    var total = sub + ship;

    $("[data-co-subtotal]").textContent = money(sub);
    var shipCell = $("[data-co-shipping]");
    shipCell.textContent = ship === 0 ? "Free" : money(ship);
    shipCell.classList.toggle("is-note", false);
    $("[data-co-total]").textContent = money(total);
    $("[data-co-mini-total]").textContent = money(total);

    /* Postage moves a whole charge at a time. Stating the rule beside the
       figure is what stops a $25 jump reading as a miscalculation. */
    var rule = $("[data-co-ship-rule]");
    var note = ship > 0 ? cart.shippingNote() : "";
    rule.hidden = !note;
    rule.textContent = note;

    if (submitBtn) submitBtn.disabled = outLines.length > 0;
  }

  // ------------------------------------------------------------ validation --

  function regionLabelFor(code) {
    return rules.regionLabels[code] || rules.defaultRegionLabel;
  }
  function regionRequired(code) { return rules.regionRequired.indexOf(code) !== -1; }
  function postalRequired(code) { return !!code && rules.noPostalCode.indexOf(code) === -1; }

  function applyCountryRules() {
    var code = $("#country").value;
    var label = $("[data-region-label]");
    var optional = $("[data-region-optional]");
    var req = regionRequired(code);
    label.childNodes[0].nodeValue = regionLabelFor(code) + " ";
    optional.hidden = req;
    $("#region").required = req;

    var postalField = $("[data-postal-field]");
    var needsPostal = postalRequired(code);
    postalField.hidden = !code ? false : !needsPostal;
    $("#postalCode").required = needsPostal;
    if (!needsPostal) clearError($("#postalCode"));
  }

  /** Deliberately permissive: one @, something either side, a dot after it. */
  function emailLooksValid(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  function messageFor(el) {
    var v = (el.value || "").trim();
    if (el.required && !v) {
      if (el.id === "country") return "Choose a country.";
      return "This field is required.";
    }
    if (!v) return "";
    if (el.id === "email" && !emailLooksValid(v)) return "Enter an email address like name@example.com.";
    if (el.id === "phone" && !/^[0-9+()\-.\s]{5,}$/.test(v)) return "Use digits, spaces and + ( ) - only.";
    return "";
  }

  function showError(el, msg) {
    var p = $('[data-error-for="' + el.id + '"]');
    if (!p) return;
    p.textContent = msg;
    p.hidden = false;
    el.setAttribute("aria-invalid", "true");
  }
  function clearError(el) {
    var p = $('[data-error-for="' + el.id + '"]');
    if (p) { p.hidden = true; p.textContent = ""; }
    el.removeAttribute("aria-invalid");
  }

  function validateField(el) {
    var msg = messageFor(el);
    if (msg) { showError(el, msg); return false; }
    clearError(el);
    return true;
  }

  /** Fields in DOM order, so "first error" means first on the page. */
  function fields() {
    return $$("#checkout input, #checkout select").filter(function (el) {
      return el.name && el.type !== "radio" && !el.closest("[hidden]");
    });
  }

  function validateAll() {
    var bad = [];
    fields().forEach(function (el) { if (!validateField(el)) bad.push(el); });
    return bad;
  }

  // ---------------------------------------------------------- order object --

  /**
   * A fresh id every call. Phase 3 puts this in PayPal's invoice_id, which
   * PayPal rejects if it has been seen before, so it must be minted per
   * payment initiation — never derived from the contents of the order.
   */
  function orderId() {
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    var rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    var tick = Date.now().toString(36).slice(-4).toUpperCase();
    return "VP-" + stamp + "-" + rand + tick;
  }
  // Exposed so phase 3 mints a new id at payment initiation.
  window.vpNewOrderId = orderId;

  function buildOrder() {
    var cart = window.vpCart;
    var f = function (n) { return (form.elements[n] ? form.elements[n].value : "").trim(); };
    var ship = shippingCents();
    var sub = cart.subtotal();

    // ⚠ THIS OBJECT IS BUILT BY THE CLIENT.
    // Phase 3 must recompute subtotal, shipping and total on the SERVER from
    // productSlug + variantId + qty alone. Never trust money that arrived from
    // a browser: everything below can be edited with devtools before it is sent.
    return {
      orderId: orderId(),
      createdAt: new Date().toISOString(),
      currency: cart.shippingConfig().currency || "USD",
      lines: cart.lines().map(function (l) {
        return {
          productSlug: l.productSlug,
          variantId: l.variantId,
          name: l.name,
          variantLabel: l.variantLabel,
          unitPriceCents: l.unitCents,
          qty: l.qty,
          lineTotalCents: l.lineCents,
        };
      }),
      subtotalCents: sub,
      shippingCents: ship, // null while the shipping policy is switched off
      totalCents: sub + (ship || 0),
      customer: {
        email: f("email"),
        firstName: f("firstName"),
        lastName: f("lastName"),
        phone: f("phone"),
      },
      shippingAddress: {
        line1: f("addressLine1"),
        line2: f("addressLine2"),
        city: f("city"),
        region: f("region"),
        postalCode: f("postalCode"),
        country: f("country"),
      },
      shippingMethod: window.vpCart.shippingConfig().enabled
        ? { id: "per-pack", label: window.vpCart.shippingBlocks() + " × pack postage" }
        : { id: "free", label: "Free shipping" },
      status: "draft",
    };
  }

  function submit(e) {
    e.preventDefault();
    if (submitting) return; // second click inside the same burst
    var cart = window.vpCart;

    if (cart.hasOutOfStock()) {
      var warn = $("[data-co-stock-warning]");
      warn.hidden = false;
      warn.focus && warn.focus();
      return;
    }

    var bad = validateAll();
    if (bad.length) {
      bad[0].focus();
      return;
    }

    // Double-click protection is a TIME window, not a content comparison.
    // Reusing an id whenever the cart and form matched meant a customer who
    // deliberately reordered exactly the same items got the same order id
    // again — and PayPal rejects a repeated invoice_id, so their second
    // purchase would fail. Identical repeat orders must get their own id.
    var now = Date.now();
    if (currentOrder && now - lastSubmitAt < DOUBLE_CLICK_MS) {
      showOrder(currentOrder);
      return;
    }
    lastSubmitAt = now;

    submitting = true;
    if (submitBtn) submitBtn.disabled = true;

    var order = buildOrder();
    currentOrder = order;

    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch (err) {
      /* storage blocked — the object is still shown below */
    }
    window.__vpLastOrder = order;
    showOrder(order);

    // The cart is intentionally left untouched: nothing has been paid for.
    if (submitBtn) submitBtn.disabled = false;
    submitting = false;
  }

  function showOrder(order) {
    devoutJson.textContent = JSON.stringify(order, null, 2);
    devout.hidden = false;
    devout.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ------------------------------------------------------------------ wire --

  function wireSteps() {
    var ids = ["review", "delivery", "payment"];
    $$("[data-step-to]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = document.getElementById(btn.getAttribute("data-step-to"));
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          target.focus({ preventScroll: true });
        }
      });
    });

    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var idx = ids.indexOf(en.target.id);
          if (idx === -1) return;
          $$("[data-step-to]").forEach(function (b, i) {
            b.classList.toggle("is-current", i === idx);
            b.classList.toggle("is-done", i < idx);
            if (i === idx) b.setAttribute("aria-current", "step");
            else b.removeAttribute("aria-current");
          });
        });
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }

  function wire() {
    /* "Buy it now" hands this page a single product instead of the basket.
       Resuming it BEFORE anything reads the cart is what keeps the basket out
       of the totals; the shopper's saved items stay in localStorage, untouched,
       and are still there when they come back. */
    if (/[?&]buynow=1\b/.test(window.location.search)) {
      if (!window.vpCart.resumeDirect()) {
        // Storage was cleared, or the tab was reopened from history. Falling
        // back to the basket would silently charge for the wrong things, so
        // send them back to the product rather than guess.
        window.location.replace("/shop");
        return;
      }
    }

    form = $("[data-co-form]");
    lines = $("[data-co-lines]");
    sumLines = $("[data-co-sum-lines]");
    empty = $("[data-co-empty]");
    grid = $("[data-co-grid]");
    devout = $("[data-co-devout]");
    devoutJson = $("[data-co-devout-json]");
    submitBtn = $("[data-co-submit]");
    if (!form) return;

    var rulesEl = document.getElementById("co-address-rules");
    if (rulesEl) {
      try { rules = JSON.parse(rulesEl.textContent); } catch (e) {}
    }

    // Validate when a field is left, never while typing.
    // Delegated on the form rather than attached per element: at wire() time the
    // grid still carries [hidden] (it is revealed once the cart has loaded), so
    // a per-element pass would find nothing to bind to. focusout is used because
    // blur does not bubble.
    form.addEventListener("focusout", function (e) {
      var el = e.target;
      if (!el || !el.name || el.type === "radio") return;
      if (el.tagName !== "INPUT" && el.tagName !== "SELECT") return;
      if (el.closest("[hidden]")) return;
      validateField(el);
    });

    $("#country").addEventListener("change", function () {
      applyCountryRules();
      validateField($("#country"));
    });

    /* There is no submit button any more — payment happens through the PayPal
       buttons. A form still submits when Enter is pressed in a text field
       though, so this stays wired: it swallows the event instead of running the
       old review-order path. */
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (submitBtn) submit(e);
    });

    lines.addEventListener("change", function (e) {
      var key = e.target.getAttribute && e.target.getAttribute("data-co-qty-for");
      if (key) window.vpCart.setQty(key, e.target.value === "" ? 1 : e.target.value);
    });
    lines.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-co-remove]");
      if (btn) window.vpCart.remove(btn.getAttribute("data-co-remove"));
    });

    var toggle = $("[data-summary-toggle]");
    var body = $("[data-summary-body]");
    if (toggle && body) {
      toggle.addEventListener("click", function () {
        var open = body.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    var clearBtn = $("[data-co-clear-draft]");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        try { window.localStorage.removeItem(ORDER_KEY); } catch (e) {}
        devout.hidden = true;
        devoutJson.textContent = "";
      });
    }

    applyCountryRules();
    wireSteps();

    // Cart changes here, in the drawer, or in another tab all re-render.
    window.addEventListener("cart:change", render);

    if (window.vpCart.state().catalog === "ready") render();
    else {
      var t = setInterval(function () {
        if (window.vpCart.state().catalog !== "loading") { clearInterval(t); render(); }
      }, 100);
    }
  }

  /**
   * Surface for the payment buttons (public/js/paypal-buttons.js).
   * Everything money-related is deliberately absent: the buttons ask the cart
   * for prices and the server recomputes them anyway.
   */
  window.vpCheckoutForm = {
    /** Silent check — used by onClick before opening PayPal. */
    isValid: function () {
      return fields().every(function (el) { return messageFor(el) === ""; });
    },
    /** Shows every error and moves focus to the first, after a blocked click. */
    revealErrors: function () {
      var bad = validateAll();
      if (bad.length) bad[0].focus();
      return bad.length;
    },
    customer: function () {
      var f = function (n) { return (form.elements[n] ? form.elements[n].value : "").trim(); };
      return { email: f("email"), firstName: f("firstName"), lastName: f("lastName"), phone: f("phone") };
    },
    address: function () {
      var f = function (n) { return (form.elements[n] ? form.elements[n].value : "").trim(); };
      return {
        line1: f("addressLine1"), line2: f("addressLine2"), city: f("city"),
        region: f("region"), postalCode: f("postalCode"), country: f("country"),
      };
    },
    /** Called once the server has confirmed a capture. */
    onPaid: function (result) {
      window.vpCart.clear();
      var panel = document.querySelector("[data-co-paid]");
      if (panel) {
        panel.hidden = false;
        var id = panel.querySelector("[data-paid-order-id]");
        var st = panel.querySelector("[data-paid-status]");
        if (id) id.textContent = result.orderId || "";
        if (st) st.textContent = result.status || "";
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      var grid = document.querySelector("[data-co-grid]");
      if (grid) grid.hidden = true;
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();

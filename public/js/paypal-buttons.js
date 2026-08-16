/* ===========================================================================
   PayPal buttons for /checkout
   ---------------------------------------------------------------------------
   TWO INDEPENDENT SWITCHES decide whether the black "Debit or Credit Card"
   button appears for shoppers without a PayPal account. Both must be left
   alone; fixing one and not the other silently loses the card button:

     1. the SDK URL must NOT list `card` in disable-funding
     2. paypal.Buttons({...}) must NOT set `fundingSource`

   With both left out, ONE Buttons instance draws both the yellow PayPal button
   and the black card button, sharing the same four handlers.

   Money note: createOrder sends amounts to PayPal so the shopper sees a total,
   but the server recomputes everything from productSlug + variantId + qty at
   capture time and refuses the order if the figures disagree. The browser is
   never the authority on price.
   =========================================================================== */
(function () {
  "use strict";

  var DEBUG = /[?&]ppdebug=1\b/.test(window.location.search);
  var slot, statusEl, cfg = null;

  function log() {
    if (!DEBUG) return;
    console.log.apply(console, arguments);
  }

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
    statusEl.className = "co-pay-status" + (kind ? " is-" + kind : "");
  }

  function money(cents) {
    return (cents / 100).toFixed(2);
  }

  /** Lines exactly as the server will re-price them: no amounts trusted. */
  function requestItems() {
    return window.vpCart.lines().map(function (l) {
      return { productSlug: l.productSlug, variantId: l.variantId, qty: l.qty };
    });
  }

  // ------------------------------------------------------------ SDK loading --

  function loadSdk(config) {
    return new Promise(function (resolve, reject) {
      var params = [
        "client-id=" + encodeURIComponent(config.client_id),
        "currency=" + encodeURIComponent(config.currency),
        "intent=capture",
        // `card` is deliberately absent — see the header comment.
        "disable-funding=credit,paylater,venmo",
        "locale=en_US",
      ];
      var src = "https://www.paypal.com/sdk/js?" + params.join("&");
      log("[PP-SDK]", src.replace(config.client_id, "<client-id>"));

      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("PayPal SDK failed to load")); };
      document.head.appendChild(s);
    });
  }

  // -------------------------------------------------------------- diagnostics --

  function probe() {
    if (!DEBUG) return;
    ["PAYPAL", "CARD"].forEach(function (k) {
      try {
        var b = window.paypal.Buttons({ fundingSource: window.paypal.FUNDING[k] });
        console.log("[PP-PROBE]", k, "eligible =", b.isEligible());
      } catch (e) {
        console.log("[PP-PROBE]", k, "error =", String(e));
      }
    });
  }

  // ---------------------------------------------------------------- handlers --

  /** Everything that must be true before PayPal is even opened. */
  function blockingReason() {
    var cart = window.vpCart;
    if (!cart || cart.lines().length === 0) return "Your cart is empty.";
    if (cart.hasOutOfStock()) return "An item in your cart is out of stock. Remove it to continue.";
    if (!cart.meetsMinOrder()) {
      return "Add " + cart.shortToMinOrder() + " more item(s) to reach the minimum order.";
    }
    if (window.vpCheckoutForm && !window.vpCheckoutForm.isValid()) {
      return "Please complete the highlighted fields above before paying.";
    }
    return null;
  }

  function buildPurchaseUnit() {
    var cart = window.vpCart;
    var lines = cart.lines();
    var currency = cfg.currency;

    var items = lines.map(function (l) {
      return {
        name: (l.name + (l.variantLabel ? " — " + l.variantLabel : "")).slice(0, 127),
        sku: (l.sku || l.productSlug + ":" + l.variantId).slice(0, 127),
        quantity: String(l.qty),
        unit_amount: { currency_code: currency, value: money(l.unitCents) },
      };
    });

    var itemTotal = lines.reduce(function (sum, l) { return sum + l.lineCents; }, 0);
    var shipping = cart.shipping(); // null while no shipping policy is on
    var shippingCents = shipping === null ? 0 : shipping;

    // PayPal returns 422 if the breakdown does not add up to the total exactly,
    // so this is computed from the same integers rather than re-derived.
    var totalCents = itemTotal + shippingCents;

    var unit = {
      // Minted fresh for every payment attempt: PayPal rejects a repeated
      // invoice_id, so a customer reordering the same basket must not reuse one.
      invoice_id: window.vpNewOrderId(),
      amount: {
        currency_code: currency,
        value: money(totalCents),
        breakdown: {
          item_total: { currency_code: currency, value: money(itemTotal) },
          shipping: { currency_code: currency, value: money(shippingCents) },
        },
      },
      items: items,
    };
    log("[PP-ORDER] purchase unit", JSON.parse(JSON.stringify(unit)));
    return unit;
  }

  function handlers() {
    return {
      onClick: function (data, actions) {
        var reason = blockingReason();
        if (reason) {
          setStatus(reason, "error");
          if (window.vpCheckoutForm) window.vpCheckoutForm.revealErrors();
          return actions.reject();
        }
        setStatus("");
        return actions.resolve();
      },

      createOrder: function (data, actions) {
        var unit = buildPurchaseUnit();
        window.__vpPendingInvoice = unit.invoice_id;
        return actions.order.create({
          intent: "CAPTURE",
          purchase_units: [unit],
          application_context: { shipping_preference: "NO_SHIPPING" },
        });
      },

      onApprove: function (data) {
        setStatus("Confirming your payment…", "pending");
        // Capture happens on the SERVER. The browser never captures, and never
        // decides what was owed.
        return fetch("/api/paypal/capture-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paypalOrderId: data.orderID,
            orderId: window.__vpPendingInvoice,
            items: requestItems(),
            customer: window.vpCheckoutForm ? window.vpCheckoutForm.customer() : null,
            shippingAddress: window.vpCheckoutForm ? window.vpCheckoutForm.address() : null,
            // Sent only so the server can COMPARE and refuse on mismatch.
            claimedTotalCents: window.vpCart.subtotal() + (window.vpCart.shipping() || 0),
          }),
        })
          /* Never assume the body is JSON. An edge error page, a proxy, or a
             gateway timeout all return plain text, and r.json() would throw
             there — turning a readable failure into a silent one at the exact
             moment money is involved. */
          .then(function (r) {
            return r.text().then(function (t) {
              var b;
              try { b = JSON.parse(t); }
              catch (e) {
                b = { ok: false, error: "unreadable_response",
                      message: "The payment service returned an unexpected reply. " +
                               "Nothing has been charged — please try again." };
              }
              return { status: r.status, body: b };
            });
          })
          .then(function (res) {
            log("[PP-CAPTURE]", res.status, res.body);
            if (res.status === 200 && res.body.ok) {
              window.__vpOrderResult = res.body;
              if (window.vpCheckoutForm) window.vpCheckoutForm.onPaid(res.body);
              return;
            }
            setStatus(
              res.body && res.body.message
                ? res.body.message
                : "We could not confirm that payment. You have not been charged twice — please contact us before retrying.",
              "error"
            );
          })
          .catch(function (err) {
            log("[PP-CAPTURE] network error", err);
            setStatus(
              "Your payment went through but we could not record it. Please contact us with your PayPal receipt before paying again.",
              "error"
            );
          });
      },

      onCancel: function () {
        // Nothing was charged and nothing was stored. The cart is untouched.
        setStatus("Payment cancelled — your cart is still here.", "info");
      },

      onError: function (err) {
        console.error("[PayPal] ", err);
        setStatus(
          "Something went wrong talking to PayPal. Your cart is unchanged — please try again in a moment.",
          "error"
        );
      },
    };
  }

  // -------------------------------------------------------------------- init --

  function mount() {
    slot = document.getElementById("payment-buttons");
    if (!slot) return;
    statusEl = document.querySelector("[data-pay-status]");

    fetch("/api/paypal/client-config")
      .then(function (r) { return r.json(); })
      .then(function (config) {
        if (!config.ok) throw new Error(config.message || "not configured");
        cfg = config;
        log("[PP-CONFIG] mode =", config.mode, "currency =", config.currency);
        return loadSdk(config);
      })
      .then(function () {
        probe();
        slot.innerHTML = "";
        // No fundingSource here — that is the second of the two switches.
        var buttons = window.paypal.Buttons(handlers());
        if (!buttons.isEligible()) {
          slot.innerHTML = '<p class="co-payment-pending">PayPal is not available for this browser.</p>';
          return;
        }
        return buttons.render("#payment-buttons");
      })
      .catch(function (err) {
        console.error("[PayPal] setup failed:", err);
        slot.innerHTML =
          '<p class="co-payment-pending">Online payment is unavailable right now. ' +
          "Nothing has been charged — please try again later.</p>";
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

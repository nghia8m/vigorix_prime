/* ===========================================================================
   Orders admin — list and detail.
   ---------------------------------------------------------------------------
   Nothing renders until /api/admin/session confirms a session. The endpoints
   enforce that themselves; this is only so the screen does not flash data or
   sit there looking broken when you are logged out.

   Money arrives as integer cents and is divided only at render time.
   =========================================================================== */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var state = { page: 1, perPage: 25, q: "", status: "", manualStatuses: [] };

  function money(cents, currency) {
    if (cents === null || cents === undefined) return "—";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || "USD",
        minimumFractionDigits: 2,
      }).format(cents / 100);
    } catch (e) {
      return "$" + (cents / 100).toFixed(2);
    }
  }

  function date(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function badge(kind, value) {
    var b = el("span", "ad-badge ad-badge--" + kind + " is-" + String(value || "none").toLowerCase(),
      value || "—");
    return b;
  }

  // ------------------------------------------------------------- session --

  function api(path, options) {
    return fetch(path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, body: b }; });
    });
  }

  function showGate(message, canLogin) {
    $("[data-admin-gate]").hidden = false;
    $("[data-admin-main]").hidden = true;
    $("[data-gate-note]").textContent = message;
    $("[data-admin-login]").hidden = !canLogin;
  }

  function showApp(login) {
    $("[data-admin-gate]").hidden = true;
    $("[data-admin-main]").hidden = false;
    var who = $("[data-admin-who]");
    who.hidden = false;
    who.textContent = "Signed in as " + login;
    $("[data-admin-logout]").hidden = false;
  }

  /**
   * Reuses the CMS's own OAuth worker: it posts the GitHub token back to the
   * opener, and we exchange it for a session cookie. The token itself is never
   * stored here.
   */
  function login() {
    var note = $("[data-gate-note]");
    note.textContent = "Opening GitHub…";

    fetch("/admin/config.yml", { credentials: "same-origin" })
      .then(function (r) { return r.text(); })
      .then(function (yaml) {
        var base = (yaml.match(/base_url:\s*(\S+)/) || [])[1];
        if (!base) throw new Error("base_url is not set in /admin/config.yml");

        var popup = window.open(
          base.replace(/\/$/, "") + "/auth?provider=github&site_id=" + encodeURIComponent(location.hostname),
          "vp-admin-login",
          "width=600,height=700"
        );
        if (!popup) throw new Error("popup blocked");

        function onMessage(e) {
          if (typeof e.data !== "string") return;
          var m = e.data.match(/^authorization:github:success:(.+)$/);
          if (!m) return;
          window.removeEventListener("message", onMessage);
          var token;
          try { token = JSON.parse(m[1]).token; } catch (err) { token = null; }
          if (!token) { note.textContent = "GitHub did not return a token."; return; }

          note.textContent = "Checking your account…";
          api("/api/admin/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token }),
          }).then(function (res) {
            if (res.status === 200 && res.body.ok) { boot(); return; }
            if (res.status === 403) {
              note.textContent = "GitHub account " + (res.body.login || "") +
                " is not on the allowed list for this admin.";
              return;
            }
            note.textContent = res.body.message || "Sign-in failed (" + res.status + ").";
          });
        }
        window.addEventListener("message", onMessage);
        popup.postMessage("authorizing:github", "*");
      })
      .catch(function (err) {
        note.textContent = "Could not start sign-in: " + err.message;
      });
  }

  function boot() {
    api("/api/admin/session").then(function (res) {
      if (res.status === 200 && res.body.ok) {
        showApp(res.body.login);
        if ($("[data-orders-body]")) loadList();
        if ($("[data-order-detail]")) loadDetail();
        return;
      }
      if (res.status === 503) {
        showGate(
          "Admin access is not configured on the server yet (" +
            (res.body.message || "missing ADMIN_SESSION_SECRET / ADMIN_GITHUB_LOGINS") +
            "). Nothing can be shown until it is.",
          false
        );
        return;
      }
      showGate("You are not signed in.", true);
    });
  }

  // ---------------------------------------------------------------- list --

  function orderRow(o) {
    var tr = el("tr", o.needs_reconciliation ? "ad-row is-incomplete" : "ad-row");

    var idCell = el("td");
    var link = el("a", "ad-id", o.order_id);
    link.href = "/admin/orders/" + encodeURIComponent(o.order_id);
    idCell.appendChild(link);
    if (o.needs_reconciliation) {
      idCell.appendChild(el("span", "ad-flag", "needs reconciliation"));
    }
    tr.appendChild(idCell);

    var name = [o.first_name, o.last_name].filter(Boolean).join(" ");
    var cust = el("td");
    if (name || o.email) {
      if (name) cust.appendChild(el("div", "ad-cust-name", name));
      if (o.email) cust.appendChild(el("div", "ad-cust-email", o.email));
    } else {
      // Not "undefined", not an empty cell that looks like a rendering bug.
      cust.appendChild(el("span", "ad-missing", "not recorded"));
    }
    tr.appendChild(cust);

    tr.appendChild(el("td", "ad-date", date(o.created_at)));
    tr.appendChild(el("td", "ad-num", o.item_count > 0 ? String(o.item_count) : "—"));
    tr.appendChild(el("td", "ad-num", money(o.total_cents, o.currency)));

    var server = el("td");
    server.appendChild(badge("server", o.status));
    tr.appendChild(server);

    var manual = el("td");
    manual.appendChild(badge("manual", o.manual_status || "not set"));
    tr.appendChild(manual);

    tr.appendChild(el("td", "ad-track", o.tracking_number || "—"));
    return tr;
  }

  function loadList() {
    var params = new URLSearchParams({
      page: String(state.page),
      perPage: String(state.perPage),
    });
    if (state.q) params.set("q", state.q);
    if (state.status) params.set("status", state.status);

    api("/api/admin/orders?" + params.toString()).then(function (res) {
      if (res.status === 401) { showGate("Your session expired.", true); return; }
      if (!res.body.ok) return;

      state.manualStatuses = res.body.manualStatuses || [];
      fillStatusFilter();

      var body = $("[data-orders-body]");
      body.innerHTML = "";
      res.body.orders.forEach(function (o) { body.appendChild(orderRow(o)); });

      $("[data-orders-empty]").hidden = res.body.orders.length > 0;
      $("[data-orders-count]").textContent =
        res.body.total + (res.body.total === 1 ? " order" : " orders");

      var pages = Math.max(1, Math.ceil(res.body.total / res.body.perPage));
      var pager = $("[data-orders-pager]");
      pager.hidden = pages <= 1;
      $("[data-page-label]").textContent = "Page " + res.body.page + " of " + pages;
      $("[data-page-prev]").disabled = res.body.page <= 1;
      $("[data-page-next]").disabled = res.body.page >= pages;
    });
  }

  function fillStatusFilter() {
    var sel = $("[data-filter-status]");
    if (!sel || sel.dataset.filled) return;
    state.manualStatuses.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    });
    sel.dataset.filled = "1";
  }

  function wireList() {
    if (!$("[data-orders-body]")) return;
    $("[data-filter-apply]").addEventListener("click", function () {
      state.q = $("[data-filter-q]").value.trim();
      state.status = $("[data-filter-status]").value;
      state.page = 1;
      loadList();
    });
    $("[data-filter-clear]").addEventListener("click", function () {
      $("[data-filter-q]").value = "";
      $("[data-filter-status]").value = "";
      state.q = ""; state.status = ""; state.page = 1;
      loadList();
    });
    $("[data-filter-q]").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("[data-filter-apply]").click(); }
    });
    $("[data-page-prev]").addEventListener("click", function () {
      if (state.page > 1) { state.page--; loadList(); }
    });
    $("[data-page-next]").addEventListener("click", function () {
      state.page++; loadList();
    });
  }

  // -------------------------------------------------------------- detail --

  function currentOrderId() {
    var m = location.pathname.match(/\/admin\/orders\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function copyRow(label, value) {
    var row = el("div", "ad-copy-row");
    row.appendChild(el("span", "ad-copy-label", label));
    row.appendChild(el("code", "ad-copy-value", value || "—"));
    if (value) {
      var btn = el("button", "ad-copy-btn", "Copy");
      btn.type = "button";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(value).then(function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy"; }, 1500);
        });
      });
      row.appendChild(btn);
    }
    return row;
  }

  function renderDetail(o, manualStatuses) {
    var host = $("[data-order-detail]");
    host.innerHTML = "";

    var head = el("div", "ad-detail-head");
    head.appendChild(el("h1", null, o.order_id));
    var badges = el("div", "ad-detail-badges");
    badges.appendChild(el("span", "ad-badge-label", "Server"));
    badges.appendChild(badge("server", o.status));
    badges.appendChild(el("span", "ad-badge-label", "Status"));
    badges.appendChild(badge("manual", o.manual_status || "not set"));
    head.appendChild(badges);
    host.appendChild(head);

    if (o.reconciliation) {
      var warn = el("div", "ad-reconcile");
      warn.appendChild(el("h2", null, "Needs manual reconciliation"));
      var ul = el("ul");
      o.reconciliation.reasons.forEach(function (r) { ul.appendChild(el("li", null, r)); });
      warn.appendChild(ul);
      warn.appendChild(el("p", "ad-reconcile-hint", o.reconciliation.hint));
      if (o.reconciliation.paypalCaptureId) {
        warn.appendChild(copyRow("PayPal capture ID", o.reconciliation.paypalCaptureId));
      }
      host.appendChild(warn);
    }

    // --- money ---
    var totals = el("section", "ad-card");
    totals.appendChild(el("h2", null, "Payment"));
    var dl = el("dl", "ad-dl");
    [
      ["Subtotal", money(o.subtotal_cents, o.currency)],
      ["Shipping", o.shipping_cents === null ? "not calculated" : money(o.shipping_cents, o.currency)],
      ["Total", money(o.total_cents, o.currency)],
      ["Placed", date(o.created_at)],
      ["Last updated", date(o.updated_at)],
    ].forEach(function (pair) {
      var d = el("div");
      d.appendChild(el("dt", null, pair[0]));
      d.appendChild(el("dd", null, pair[1]));
      dl.appendChild(d);
    });
    totals.appendChild(dl);
    totals.appendChild(copyRow("PayPal order ID", o.paypal_order_id));
    totals.appendChild(copyRow("PayPal capture ID", o.paypal_capture_id));
    host.appendChild(totals);

    // --- lines ---
    var itemsCard = el("section", "ad-card");
    itemsCard.appendChild(el("h2", null, "Items"));
    if (o.lines.length === 0) {
      itemsCard.appendChild(
        el("p", "ad-missing-block",
          "No order lines were recorded for this order. What was bought must be recovered from the PayPal capture.")
      );
    } else {
      var t = el("table", "ad-table ad-table--lines");
      var thead = el("thead");
      var hr = el("tr");
      ["Product", "Variant", "SKU", "Unit", "Qty", "Line total"].forEach(function (h) {
        hr.appendChild(el("th", null, h));
      });
      thead.appendChild(hr);
      t.appendChild(thead);
      var tb = el("tbody");
      o.lines.forEach(function (l) {
        var tr = el("tr");
        tr.appendChild(el("td", null, l.name));
        tr.appendChild(el("td", null, l.variant_label || "—"));
        tr.appendChild(el("td", "ad-mono", l.sku || "—"));
        tr.appendChild(el("td", "ad-num", money(l.unit_price_cents, o.currency)));
        tr.appendChild(el("td", "ad-num", String(l.qty)));
        tr.appendChild(el("td", "ad-num", money(l.line_total_cents, o.currency)));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      itemsCard.appendChild(t);
    }
    host.appendChild(itemsCard);

    // --- customer + address ---
    var who = el("section", "ad-card");
    who.appendChild(el("h2", null, "Customer & delivery"));
    var name = [o.first_name, o.last_name].filter(Boolean).join(" ");
    if (!name && !o.email && !o.address_line1) {
      who.appendChild(el("p", "ad-missing-block", "No customer or delivery details were recorded."));
    } else {
      var addr = el("address", "ad-address");
      [name, o.email, o.phone, o.address_line1, o.address_line2, o.city,
       o.region, o.postal_code, o.country]
        .filter(Boolean)
        .forEach(function (line) { addr.appendChild(el("div", null, line)); });
      who.appendChild(addr);
    }
    host.appendChild(who);

    // --- operator controls ---
    var ops = el("section", "ad-card");
    ops.appendChild(el("h2", null, "Fulfilment"));
    ops.appendChild(
      el("p", "ad-hint",
        "These are yours to set. The Server badge above is written only by the payment provider and is not affected by anything here.")
    );

    var form = el("form", "ad-ops-form");
    form.addEventListener("submit", function (e) { e.preventDefault(); });

    var sLabel = el("label", null, "Status");
    sLabel.setAttribute("for", "manual-status");
    var select = el("select", "ad-select");
    select.id = "manual-status";
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "not set";
    select.appendChild(none);
    manualStatuses.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === o.manual_status) opt.selected = true;
      select.appendChild(opt);
    });

    var tLabel = el("label", null, "Tracking number");
    tLabel.setAttribute("for", "tracking");
    var track = el("input", "ad-input");
    track.id = "tracking";
    track.type = "text";
    track.value = o.tracking_number || "";
    track.placeholder = "e.g. VN123456789";

    var save = el("button", "btn btn-shop", "Save");
    save.type = "button";
    var status = el("p", "ad-save-status");

    save.addEventListener("click", function () {
      save.disabled = true;
      status.textContent = "Saving…";
      api("/api/admin/orders/" + encodeURIComponent(o.order_id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualStatus: select.value, trackingNumber: track.value }),
      }).then(function (res) {
        save.disabled = false;
        if (res.status !== 200 || !res.body.ok) {
          status.textContent = "Could not save (" + res.status + ").";
          return;
        }
        status.textContent = res.body.unchanged ? "Nothing changed." : "Saved.";
        if (res.body.order) renderDetail(res.body.order, manualStatuses);
      });
    });

    form.appendChild(sLabel); form.appendChild(select);
    form.appendChild(tLabel); form.appendChild(track);
    form.appendChild(save); form.appendChild(status);
    ops.appendChild(form);
    host.appendChild(ops);

    // --- history ---
    var hist = el("section", "ad-card");
    hist.appendChild(el("h2", null, "History"));
    if (!o.events.length) {
      hist.appendChild(el("p", "ad-missing-block", "No events recorded."));
    } else {
      var list = el("ol", "ad-events");
      o.events.forEach(function (ev) {
        var li = el("li", "ad-event");
        li.appendChild(el("span", "ad-event-src ad-event-src--" + ev.source, ev.source));
        li.appendChild(el("span", "ad-event-type", ev.event_type));
        if (ev.status_after) li.appendChild(el("span", "ad-event-status", "→ " + ev.status_after));
        li.appendChild(el("span", "ad-event-time", date(ev.created_at)));
        if (ev.source === "admin" && ev.payload) {
          try {
            var p = JSON.parse(ev.payload);
            li.appendChild(
              el("span", "ad-event-diff",
                p.field + ": " + (p.from || "not set") + " → " + (p.to || "not set") +
                (p.by ? "  (by " + p.by + ")" : ""))
            );
          } catch (e) { /* payload not JSON; the summary above is enough */ }
        }
        list.appendChild(li);
      });
      hist.appendChild(list);
    }
    host.appendChild(hist);
  }

  function loadDetail() {
    var id = currentOrderId();
    api("/api/admin/orders/" + encodeURIComponent(id)).then(function (res) {
      if (res.status === 401) { showGate("Your session expired.", true); return; }
      if (res.status === 404) {
        $("[data-order-detail]").innerHTML = "<p class='ad-missing-block'>No such order.</p>";
        return;
      }
      if (!res.body.ok) return;
      renderDetail(res.body.order, res.body.manualStatuses || []);
    });
  }

  // ---------------------------------------------------------------- init --

  function init() {
    var loginBtn = $("[data-admin-login]");
    if (loginBtn) loginBtn.addEventListener("click", login);
    var out = $("[data-admin-logout]");
    if (out) {
      out.addEventListener("click", function () {
        api("/api/admin/session", { method: "DELETE" }).then(function () { location.reload(); });
      });
    }
    wireList();
    boot();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

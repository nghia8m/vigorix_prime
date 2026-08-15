-- Orders written by the server after PayPal confirms a capture.
--
-- Every money column is INTEGER CENTS. No floats anywhere near an amount.
-- Every figure stored here was computed by the server from productSlug +
-- variantId + qty; nothing a browser sent is persisted as an amount.

CREATE TABLE IF NOT EXISTS orders (
  order_id            TEXT PRIMARY KEY,          -- our id, also PayPal invoice_id
  paypal_order_id     TEXT UNIQUE,               -- PayPal's order id
  paypal_capture_id   TEXT,                      -- capture id, for refunds
  status              TEXT NOT NULL,             -- paid | pending | denied | refunded | reversed | disputed | failed
  currency            TEXT NOT NULL,

  subtotal_cents      INTEGER NOT NULL,
  shipping_cents      INTEGER,                   -- NULL when no shipping policy applied
  total_cents         INTEGER NOT NULL,

  shipping_method_id    TEXT,
  shipping_method_label TEXT,

  email        TEXT NOT NULL,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  phone        TEXT,

  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city          TEXT NOT NULL,
  region        TEXT,
  postal_code   TEXT,
  country       TEXT NOT NULL,

  -- Raw PayPal capture response, kept verbatim for reconciliation.
  paypal_raw   TEXT,

  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_slug     TEXT NOT NULL,
  variant_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  variant_label    TEXT,
  sku              TEXT,
  unit_price_cents INTEGER NOT NULL,
  qty              INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL
);

-- Every webhook and capture that touched an order, append-only. When a payment
-- state is disputed later, this is the record of what arrived and when.
CREATE TABLE IF NOT EXISTS order_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT,
  source       TEXT NOT NULL,     -- capture | webhook
  event_type   TEXT NOT NULL,
  paypal_id    TEXT,
  status_after TEXT,
  payload      TEXT,
  created_at   TEXT NOT NULL
);

-- The phase 4 Orders screen filters on these.
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_email      ON orders(email);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

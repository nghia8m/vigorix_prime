-- Operator-controlled fields, kept apart from anything the server confirmed.
--
-- orders.status stays the SERVER's word: it is written by capture and by
-- verified webhooks only. manual_status is what the person packing boxes sets.
-- Mixing them would let a hand-typed "paid" look identical to a payment PayPal
-- actually confirmed.

ALTER TABLE orders ADD COLUMN manual_status TEXT;
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN admin_note TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_manual_status ON orders(manual_status);

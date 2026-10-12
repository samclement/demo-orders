-- Orders, as POST /orders stores them. The app keeps the latest 1000 (src/app.ts).
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  placed_by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX orders_at ON orders (at);

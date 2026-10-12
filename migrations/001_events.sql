-- The first migration: one table the example code writes to. Replace it with the app's own schema
-- before the app has real data; afterwards add 002_*.sql and so on (see src/db.ts).
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);

// The database module (npm run build first): migrations run once each, and data outlives a reopen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../dist/db.js";

test("migrations apply once and data persists", () => {
  const path = join(mkdtempSync(join(tmpdir(), "app-")), "app.db");
  let db = openDatabase(path);
  db.prepare("INSERT INTO events (kind, detail, at) VALUES ('test', 'x', 'now')").run();
  db.close();
  db = openDatabase(path);
  assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE name = '001_events.sql'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();
});

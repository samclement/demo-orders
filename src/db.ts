import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The app's SQLite database. On the platform DATABASE_PATH is /data/app.db, a file on a volume that
// outlives the pod, backed up nightly (one copy of the app runs at a time). Locally it defaults to
// app.db here. Uses Node's built-in node:sqlite, so there is no native module to build.
export function openDatabase(path = process.env.DATABASE_PATH ?? "app.db"): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL lets the platform's backup copy the database while the app writes.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db, new URL("../migrations/", import.meta.url));
  return db;
}

// Migrations: migrations/NNN_name.sql, applied once each, in name order, at startup, each in a
// transaction and recorded in schema_migrations. Add a new file for every change; never edit one
// that has run (staging and production each keep their own database).
export function migrate(db: DatabaseSync, directory: URL): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((row) => String((row as { name: string }).name)),
  );
  const ran: string[] = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(new URL(name, directory), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    ran.push(name);
  }
  return ran;
}

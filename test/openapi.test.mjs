// openapi.json is what other apps read to call this one. It is generated from the routes
// (npm run openapi); this fails when the routes changed and the file was not regenerated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), "app-")), "app.db");
const { app, openapi } = await import("../dist/app.js");

test("openapi.json matches the routes", () => {
  assert.deepEqual(JSON.parse(readFileSync("openapi.json", "utf8")), JSON.parse(JSON.stringify(openapi())),
    "run `npm run build && npm run openapi` and commit openapi.json");
});

test("the description is served, and describes the example route", async () => {
  const served = await (await app.request("/openapi.json")).json();
  assert.match(served.openapi, /^3\.1\./);
  assert.ok(served.paths["/"].get.responses["200"]);
  const reply = await app.request("/");
  assert.equal(reply.status, 200);
  assert.equal(typeof (await reply.json()).message, "string");
});

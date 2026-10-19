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

test("the served description names the app the platform runs it as", async () => {
  process.env.SWHURL_APP = "orders";
  process.env.SWHURL_DESCRIPTION = "Orders, kept for a year";
  try {
    const { info } = await (await app.request("/openapi.json")).json();
    assert.deepEqual([info.title, info.description], ["orders", "Orders, kept for a year"]);
  } finally {
    delete process.env.SWHURL_APP;
    delete process.env.SWHURL_DESCRIPTION;
  }
});

test("the description is served, and describes the example route", async () => {
  const served = await (await app.request("/openapi.json")).json();
  assert.match(served.openapi, /^3\.1\./);
  // "/", or "/api/hello" in an app with a browser frontend (which is served at "/").
  const [path] = Object.keys(served.paths).filter((each) => served.paths[each].get?.summary === "Say hello and name the caller");
  assert.ok(served.paths[path].get.responses["200"]);
  const reply = await app.request(path);
  assert.equal(reply.status, 200);
  assert.equal(typeof (await reply.json()).message, "string");
});

// demo-orders' own routes, asked through the app (npm run build first). A token is signed with a
// key made for the test, as the cluster signs real ones: only an app may place an order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ISSUER = "https://kubernetes.default.svc.cluster.local";
Object.assign(process.env, {
  DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "app-")), "app.db"),
  SWHURL_APP: "demo-orders",
  SWHURL_ENV: "staging",
  SWHURL_AUTH_ISSUER: ISSUER,
  SWHURL_AUTH_KEYS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] }),
  SWHURL_ALLOWED_CALLERS: "demo-shop",
});
const { app } = await import("../dist/app.js");

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(caller = "demo-shop") {
  const body = `${encode({ alg: "RS256", kid: "k1" })}.${encode({
    iss: ISSUER, aud: ["demo-orders"], exp: Math.floor(Date.now() / 1000) + 600,
    sub: `system:serviceaccount:${caller}-staging:${caller}`,
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}
const place = (order, headers = { authorization: `Bearer ${token()}` }) => app.request("/orders", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(order),
});

test("an app places an order and it can be read back", async () => {
  const placed = await place({ item: "tea", quantity: 2 });
  assert.equal(placed.status, 201);
  const order = await placed.json();
  assert.deepEqual({ ...order, id: "", at: "" }, { id: "", item: "tea", quantity: 2, placedBy: "demo-shop", at: "" });
  assert.deepEqual(await (await app.request(`/orders/${order.id}`)).json(), order);
  const { orders } = await (await app.request("/orders?limit=5")).json();
  assert.equal(orders[0].id, order.id, "newest first");
  assert.equal((await app.request("/orders/nope")).status, 404);
  assert.equal((await (await app.request("/")).json()).orders, 1);
});

test("a person, an app that is not allowed and a bad order are refused", async () => {
  assert.equal((await place({ item: "tea", quantity: 1 }, {})).status, 401, "anonymous");
  assert.equal((await place({ item: "tea", quantity: 1 }, { "x-auth-request-email": "sam@example.com" })).status, 401, "signed in");
  assert.equal((await place({ item: "tea", quantity: 1 }, { authorization: `Bearer ${token("stranger")}` })).status, 401);
  assert.equal((await place({ item: "", quantity: 1 })).status, 400);
  assert.equal((await place({ item: "tea", quantity: 0 })).status, 400);
});

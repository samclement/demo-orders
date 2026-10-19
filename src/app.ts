// The app's routes. src/server.ts listens with them; src/openapi.ts writes their description to openapi.json.
import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { openDatabase } from "./db.js";
import { publish } from "./events.js";
import { flagsLoaded } from "./flags.js";
import { type Caller, Unauthorized, identify, requireApp } from "./platform.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

const serviceName = process.env.OTEL_SERVICE_NAME ?? "swhurl-app";
// Who this app is, as the platform names and describes it (SWHURL_APP; SWHURL_DESCRIPTION, from
// swhurl.yaml), or as it was created off the platform: an image built for another app says the right thing.
const identity = () => ({
  name: process.env.SWHURL_APP || "demo-orders",
  description: process.env.SWHURL_DESCRIPTION || "Demo: takes orders, keeps them in SQLite, describes its API and publishes an event for each",
});
// DATABASE_PATH comes from the platform (a file on a volume that outlives the pod); app.db locally.
export const db = openDatabase();
const recordVisit = db.prepare("INSERT INTO events (kind, detail, at) VALUES ('visit', ?, ?)");
const countVisits = db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'visit'");
// Orders (migrations/002_orders.sql). The table keeps the latest KEEP orders: a demo that takes an
// order every half minute must not grow for ever.
const KEEP = 1000;
const insertOrder = db.prepare("INSERT INTO orders (id, item, quantity, placed_by, at) VALUES (?, ?, ?, ?, ?)");
const trimOrders = db.prepare("DELETE FROM orders WHERE id NOT IN (SELECT id FROM orders ORDER BY at DESC LIMIT ?)");
const latestOrders = db.prepare("SELECT id, item, quantity, placed_by AS placedBy, at FROM orders ORDER BY at DESC LIMIT ?");
const oneOrder = db.prepare("SELECT id, item, quantity, placed_by AS placedBy, at FROM orders WHERE id = ?");
const countOrders = db.prepare("SELECT count(*) AS n FROM orders");

export const app = new OpenAPIHono<{ Variables: { caller: Caller } }>();
const traceId = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

app.onError((error, c) => {
  logger.error({ err: error, path: c.req.path }, "request failed");
  return c.json({ error: "internal error" }, 500);
});

// What the platform probes: no caller check, no log line. Not ready until the app's feature flag
// overrides have arrived (at most 5 s; src/flagstore.ts).
app.get("/healthz", (c) => {
  if (!flagsLoaded()) return c.json({ ok: false, waiting: "feature flag overrides" }, 503);
  db.prepare("SELECT 1").get(); // ready only when the database answers
  return c.json({ ok: true });
});

// Who is calling: another app (it sent a token the platform issued for this app alone), a
// signed-in person, or anonymous. A bad token is refused here; see src/platform.ts.
app.use(async (c, next) => {
  const start = Date.now();
  let caller: Caller;
  try {
    caller = identify(Object.fromEntries(c.req.raw.headers));
  } catch (error) {
    if (!(error instanceof Unauthorized)) throw error;
    logger.warn({ method: c.req.method, path: c.req.path, status: 401, reason: error.message, trace_id: traceId() },
      "request refused");
    return c.json({ error: error.message }, 401);
  }
  c.set("caller", caller);
  const span = trace.getActiveSpan();
  span?.setAttribute("caller.type", caller.type);
  if (caller.id) span?.setAttribute("caller.id", caller.id);
  const person = caller.type === "app" ? caller.user : undefined;
  if (person) span?.setAttribute("user.email", person);
  await next();
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
    "caller.type": caller.type,
    "caller.id": caller.id,
    ...(person ? { "user.email": person } : {}),
    trace_id: traceId(),
  }, "request handled");
});

// The front door: what this app is and how much it holds. Each request is recorded (the events
// table of migrations/001_events.sql), which is also what the image's smoke test looks for.
function hello(caller: Caller) {
  recordVisit.run("/", new Date().toISOString());
  return {
    message: `hello from ${serviceName}`,
    service: serviceName,
    caller,
    visits: Number((countVisits.get() as { n: number }).n),
    orders: Number((countOrders.get() as { n: number }).n),
    traceId: traceId(),
  };
}

// Described routes: the schemas are what each handler takes and returns, and what openapi.json says.
// After changing one, run `npm run build && npm run openapi`; a test fails while the file is out of date.
const CallerSchema = z.object({ type: z.enum(["app", "user", "anonymous"]), id: z.string().nullable() }).openapi("Caller");
const Hello = z.object({
  message: z.string().openapi({ example: `hello from ${identity().name}` }),
  service: z.string(),
  caller: CallerSchema,
  visits: z.number().int(),
  orders: z.number().int().openapi({ description: "How many orders it holds (the latest 1000 are kept)" }),
  traceId: z.string().nullable(),
}).openapi("Hello");
const Order = z.object({
  id: z.string().openapi({ example: "3f0c7d0e-6f0f-4b3e-9d4f-0a8f6d1c2b3a" }),
  item: z.string().openapi({ example: "tea" }),
  quantity: z.number().int().openapi({ example: 2 }),
  placedBy: z.string().openapi({ description: "The app that placed it", example: "demo-shop" }),
  at: z.string().openapi({ description: "When it was placed (ISO 8601)", example: "2026-01-01T00:00:00.000Z" }),
}).openapi("Order");
const NewOrder = z.object({
  item: z.string().min(1).max(40).openapi({ example: "tea" }),
  quantity: z.number().int().min(1).max(1000).openapi({ example: 2 }),
}).openapi("NewOrder");
const Problem = z.object({ error: z.string() }).openapi("Problem");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

app.openapi(
  createRoute({ method: "get", path: "/", summary: "Say hello and how many orders there are", responses: { 200: json(Hello, "A greeting") } }),
  (c) => c.json(hello(c.get("caller")), 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/orders",
    summary: "Place an order (apps only)",
    description: "Only another app may place an order: it declares a call to demo-orders and sends the token the platform gives it. "
      + "A person, signed in or not, is answered 401. Each order is published as the event demo-orders.created.",
    request: { body: { required: true, content: { "application/json": { schema: NewOrder } } } },
    responses: { 201: json(Order, "The order, as stored"), 401: json(Problem, "The caller is not an app allowed to call this one") },
  }),
  async (c) => {
    let placedBy: string;
    try {
      placedBy = requireApp(c.get("caller"));
    } catch (error) {
      if (!(error instanceof Unauthorized)) throw error;
      return c.json({ error: error.message }, 401);
    }
    const { item, quantity } = c.req.valid("json");
    const order = { id: randomUUID(), item, quantity, placedBy, at: new Date().toISOString() };
    insertOrder.run(order.id, order.item, order.quantity, order.placedBy, order.at);
    trimOrders.run(KEEP);
    // The order is stored whatever happens next: an event that cannot be sent is logged, not a failed order.
    try {
      await publish("created", order);
    } catch (error) {
      logger.error({ err: error, event: "created", order_id: order.id, trace_id: traceId() }, "event not published");
    }
    return c.json(order, 201);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/orders",
    summary: "The latest orders, newest first",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }) }) },
    responses: { 200: json(z.object({ orders: z.array(Order) }).openapi("Orders"), "Up to `limit` orders") },
  }),
  (c) => c.json({ orders: latestOrders.all(c.req.valid("query").limit) as z.infer<typeof Order>[] }, 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/orders/{id}",
    summary: "One order",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(Order, "The order"), 404: json(Problem, "No such order (only the latest 1000 are kept)") },
  }),
  (c) => {
    const order = oneOrder.get(c.req.valid("param").id) as z.infer<typeof Order> | undefined;
    return order ? c.json(order, 200) : c.json({ error: "no such order" }, 404);
  },
);

/** What this app offers other apps: generated from the routes above, served and kept in openapi.json. */
export const openapi = () => app.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: identity().name, version: "0.1.0", description: identity().description },
});
app.get("/openapi.json", (c) => c.json(openapi()));

app.notFound((c) => c.json({ error: "not found" }, 404));

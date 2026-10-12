// The app's routes. src/server.ts listens with them; src/openapi.ts writes their description to openapi.json.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { openDatabase } from "./db.js";
import { publish } from "./events.js";
import { type Caller, Unauthorized, identify, notify, service } from "./platform.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

const serviceName = process.env.OTEL_SERVICE_NAME ?? "swhurl-app";
// DATABASE_PATH comes from the platform (a file on a volume that outlives the pod); app.db locally.
export const db = openDatabase();
const recordVisit = db.prepare("INSERT INTO events (kind, detail, at) VALUES ('visit', ?, ?)");
const countVisits = db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'visit'");

export const app = new OpenAPIHono<{ Variables: { caller: Caller } }>();
const traceId = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

app.onError((error, c) => {
  logger.error({ err: error, path: c.req.path }, "request failed");
  return c.json({ error: "internal error" }, 500);
});

// What the platform probes: no caller check, no log line.
app.get("/healthz", (c) => {
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
  await next();
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
    "caller.type": caller.type,
    "caller.id": caller.id,
    trace_id: traceId(),
  }, "request handled");
});

// An example of calling another app: GET /call/orders asks the app "orders" for its "/" and
// returns what it said. It works once this app declares the call (calls: [orders] in swhurl.yaml).
app.get("/call/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const reply = await service(name).fetch("/");
    return c.json({ called: name, status: reply.status, reply: await reply.json().catch(() => null) }, reply.ok ? 200 : 502);
  } catch (error) {
    return c.json({ called: name, error: (error as Error).message }, 502);
  }
});

// An example of notifying the team: POST /notify sends a message to the notification channel of
// the team that owns this app, and says whether the platform accepted it.
app.post("/notify", async (c) => {
  const caller = c.get("caller");
  const sent = await notify("Hello from the example route", { message: `Asked for by ${caller.id ?? "an anonymous caller"}.` });
  return c.json({ sent });
});

// The example route: says hello, names the caller, counts visits and publishes an event.
async function hello(caller: Caller) {
  recordVisit.run("/", new Date().toISOString());
  const visits = Number((countVisits.get() as { n: number }).n);
  // An example of publishing: "visited" is described in asyncapi.yaml, which is what lets other
  // apps find it and subscribe. Off the platform the payload is still checked, and nothing is sent.
  const published = "visited";
  let eventId: string | null = null;
  if (published) {
    try {
      eventId = (await publish(published, { path: "/", caller }))?.id ?? null;
    } catch (error) {
      logger.error({ err: error, event: published, trace_id: traceId() }, "event not published");
    }
  }
  return {
    message: `hello from ${serviceName}`,
    service: serviceName,
    caller,
    visits,
    event: eventId ? { type: `${serviceName}.${published}`, id: eventId } : null,
    traceId: traceId(),
  };
}

// A described route: the schemas below are what the handler must return and what openapi.json says.
// Add routes the same way and run `npm run openapi`; CI fails if openapi.json is out of date.
const Hello = z.object({
  message: z.string().openapi({ example: "hello from demo-orders" }),
  service: z.string(),
  caller: z.object({ type: z.enum(["app", "user", "anonymous"]), id: z.string().nullable() }),
  visits: z.number().int().optional().openapi({ description: "How many times it was asked, when the app keeps a database" }),
  event: z.object({ type: z.string(), id: z.string() }).nullable().openapi({ description: "The event this request published, if any" }),
  traceId: z.string().nullable(),
}).openapi("Hello");

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "Say hello and name the caller",
    responses: { 200: { description: "A greeting", content: { "application/json": { schema: Hello } } } },
  }),
  async (c) => c.json(await hello(c.get("caller")), 200),
);

/** What this app offers other apps: generated from the routes above, served and kept in openapi.json. */
export const openapi = () => app.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "demo-orders", version: "0.1.0", description: "Demo: takes orders, keeps them in SQLite, describes its API and publishes an event for each" },
});
app.get("/openapi.json", (c) => c.json(openapi()));

app.notFound((c) => c.json({ error: "not found" }, 404));

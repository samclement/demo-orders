# demo-orders

> **A demo app of the swhurl platform.** With [demo-shop](https://github.com/samclement/demo-shop), [demo-shopper](https://github.com/samclement/demo-shopper) and [demo-notifier](https://github.com/samclement/demo-notifier) it shows how apps on the platform work together. This one shows:
>
> - **An API only other apps may use.** `POST /orders` asks for an app caller (`requireApp` in `src/app.ts`): demo-shop declared a call to this app, so the platform gives it a token that only demo-orders accepts. A person, signed in or not, gets 401.
> - **A described API.** `openapi.json` is generated from the routes; the platform's Catalogue lists them.
> - **A described event.** Every order is published as `demo-orders.created`; `asyncapi.yaml` says what it carries, and that file is all the platform needs to let other apps subscribe.
> - **A database.** Orders are kept in SQLite on a volume the platform backs up nightly (`migrations/002_orders.sql`); the latest 1000 are kept.

Demo: takes orders, keeps them in SQLite, describes its API and publishes an event for each

A TypeScript app on the [swhurl platform](https://github.com/samclement/swhurl-platform), made from the [swhurl TypeScript template](https://github.com/samclement/swhurl-app-template-typescript). Every push to `main` is checked, published to `ghcr.io/<owner>/demo-orders` and deployed to staging; production changes through **Promote to production**. What the image must provide, the checks and the dependency updates: the [template's guide](https://github.com/samclement/swhurl-app-template-typescript#readme). What the app needs from the platform: [`swhurl.yaml`](swhurl.yaml).

An HTTP service on [Hono](https://hono.dev): `src/app.ts` holds the routes and `src/server.ts` listens on port 8080; the platform probes `GET /healthz`. It keeps its data in SQLite (`src/db.ts`): on the platform the file is `/data/app.db` (`DATABASE_PATH`) on a volume that outlives the pod, backed up nightly; staging and production each have their own. Change the schema by adding `migrations/NNN_name.sql` (applied once each, in order, at startup); never edit one that has run. Image rollback does not reverse database migrations; review compatibility before promoting an older image.

## Callers and calling other apps

`src/platform.ts` holds what the platform gives the app ([calling another app](https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#calling-another-app)):

- **Who is calling.** `identify(headers)` returns `{ type: "app", id: "<app>" }` for another app that sent a token the platform issued for this app alone, `{ type: "user", id: "<email>" }` for a signed-in person, or `anonymous`. A bad token throws `Unauthorized`, which `src/app.ts` answers with 401. Every log line and span carries `caller.type` and `caller.id`. For a route only apps may use, call `requireApp(caller)`.
- **Secrets.** List each secret variable the app reads under `secrets:` in `swhurl.yaml` and read it with `secret("API_TOKEN")` (from `src/platform.ts`). Its value is set on the platform, never here: `make app-secret APP=<app> ENV=<env> NAME=API_TOKEN` in the platform checkout. A name pushed before its value deploys all the same; `secret()` then fails with a message naming that command, and the app page shows it as value missing.
- **Calling another app.** A call is granted on the platform, not in this repository: tick `orders` under **Connections** when creating the app, or later use the app page's **Connect to an app** or `make app-calls`. Then `await service("orders").fetch("/path")` reaches the same environment's `orders` with this app's token for it; the callee's spans join the same trace. `GET /call/orders` in `src/app.ts` is an example to replace.

## Reaching outside the cluster

A request to a host outside the cluster goes through the platform's egress proxy, which knows this app by the port it uses ([reaching outside the cluster](https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#reaching-outside-the-cluster)). Which hosts the app may reach is a grant on the platform, per environment, not in this repository: the app page's **Reach a host outside**, or `make app-egress APP=demo-orders ENV=staging ARGS="--add api.example.com"` (port 443 unless named; `*.example.com` is every name under it). Production is granted on its own, after promotion: a promotion never widens it.

- **Today nothing is refused.** The proxy logs every request with whether a grant covers it: in ClickStack, service `egress`, a `granted=-` line with this app's name is a host to grant before the platform starts refusing ungranted hosts and connections that bypass the proxy ([plan](https://github.com/samclement/swhurl-platform/blob/main/docs/plan.md#stage-5-egress-grants)).
- **Other apps, events, notifications and telemetry** stay inside the cluster and never use the proxy (`NO_PROXY`).
- **Clients that use the proxy with no code:** Node's own `fetch` and the `node:http` and `node:https` default agents, because the platform sets `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` and `NO_PROXY`.
- **A library with its own HTTP agent** (an undici `Agent` or `Dispatcher` you create, `got`, a payment or cloud provider's SDK): check that it reads `HTTPS_PROXY`, or give it the proxy from that variable in its own settings.
- **Locally** there is no proxy: the variables are unset and requests go direct.

## Notifications

`await notify("Order backlog", { message: "412 orders waiting", priority: "high" })` (from `src/platform.ts`) sends a message to the notification channel of the team that owns this app ([notifications](https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#notifications)). Nothing is declared in `swhurl.yaml`: the platform gives every app the address and a token. The message arrives titled `<app>/<env>: Order backlog`. The call resolves to whether the platform accepted it and never throws; an app may send 30 an hour, and a team without a channel delivers nothing. `POST /notify` in `src/server.ts` is an example to replace. Locally there is no notify service: `notify` resolves to `false` and sends nothing.

## Feature flags

Declare a flag in `swhurl.yaml` with a type, a default and, where it differs, a value for `staging` or `prod` ([feature flags](https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#feature-flags)):

```yaml
flags:
  new-checkout: {type: boolean, description: Use the new checkout flow, default: false, staging: true}
```

Every build, type-check, test and `npm run dev` first runs `scripts/flags.mjs`, which checks the declarations and writes `src/flags.ts` (ignored by Git): `import { flags } from "./flags.js"`, then `if (flags.newCheckout)`. On the platform an override set from the console wins: the app watches its own overrides over NATS (`src/flagstore.ts`) and the next read returns the new value, without a restart. Otherwise a flag is the value declared for `SWHURL_ENV`, else its default, which is also what local development gets. A restart keeps the override; `/healthz` reports not ready until the stored overrides arrive (at most 5 s). Types: `boolean`, `integer`, `number` (with optional `min` and `max`) and `string` (with an optional `enum`). To remove a flag, delete it from `swhurl.yaml`: `npm run check` then names each place that still reads it.

## Events

`src/events.ts` publishes and receives events on the platform's NATS ([events](https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#events)). What it publishes is an offer: declare it in `swhurl.yaml` before the app is created (afterwards: `make app-events` on the platform), or, as this app does, in `asyncapi.yaml`:

```yaml
events:
  publish: [created]               # other apps see demo-orders.created
```

What it receives is a grant, set on the platform: tick `orders.created` under **Connections** when creating the app, or later use the app page's **Connect to an app** or `make app-events ARGS="--add-subscribe orders.created"`.

Then `await publish("created", data)` and `await subscribe("orders.created", async (event) => { ... })`. An event is a CloudEvents envelope (`event.data` is what was published); a handler runs inside the publisher's trace, and if it throws the event comes back, five tries in all. `src/app.ts` publishes `visited` on every request to `/` and logs every event it subscribes to: examples to replace. `subscribe` keeps trying until it is receiving, since a new app can start before NATS knows it. Locally there is no NATS: `publish` returns `null` and `subscribe` never calls back.

### The events this app offers: `asyncapi.yaml`

[`asyncapi.yaml`](asyncapi.yaml) describes each event demo-orders publishes ([AsyncAPI 3](https://www.asyncapi.com/docs)): its name, what it means, the schema of its payload and an example. It is the declaration. The platform reads it to show other apps what they can subscribe to, and `publish()` throws `EventInvalid` for an event that is not in it or a payload that does not fit, locally as well as on the platform.

To add an event, add to `asyncapi.yaml` a channel (its `address` is the event's name), a message with a `payload` schema and an example, and a `send` operation; then call `publish("<name>", data)`. `test/asyncapi.test.mjs` checks the file is valid AsyncAPI and that every example fits its schema. Nothing else is declared: after the push, the platform reads the file for the new image and other apps can subscribe ([what an app offers](https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#what-an-app-offers)).

## The API this app offers: `openapi.json`

Routes written with `createRoute` in `src/app.ts` carry their request and response schemas ([zod](https://zod.dev)), and [`openapi.json`](openapi.json) is generated from them ([OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)); the app also serves it at `/openapi.json`. The platform reads the file to show other apps what they can call.

After changing a described route, run `npm run build && npm run openapi` and commit `openapi.json`: `test/openapi.test.mjs` fails while the file and the routes disagree, so a change to the API always shows in a pull request. A route added with plain `app.get(...)` works but is not described.

## Without the platform

Locally there are no platform keys or tokens: requests without a token work as before and a request with one is refused; to call another app, set `SWHURL_SERVICE_<NAME>_URL` to a local stub.

The image build compiles and tests once. Matching merges to `main` publish the image that passed the pull request tests and smoke test; see the [template guide](https://github.com/samclement/swhurl-app-template-typescript#readme) for reuse checks and fallback builds.

## Local development

```bash
npm install
npm run dev                             # the SDK stays off locally (the image turns it on)
curl http://localhost:8080/healthz
npm run check                           # type-check without writing JavaScript
npm run build && npm test               # the tests run against the built app
```

Locally the database is `app.db` in this directory (ignored by Git); delete it to start again.

To see telemetry locally, `npm run build`, then `OTEL_TRACES_EXPORTER=console node --import ./dist/instrumentation.js dist/main.js` prints spans (or run an OpenTelemetry collector on `localhost:4318` and drop the variable).

// asyncapi.yaml is what other apps read to subscribe to this app's events, and what src/events.ts
// holds each publish to. This checks the file itself: it is a valid AsyncAPI 3 document, every
// event it sends has a schema and an example, and each example fits its schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { parse } from "yaml";
import { EventInvalid, describedEvents, publish } from "../dist/events.js";

const doc = parse(readFileSync("asyncapi.yaml", "utf8"));
const at = (ref) => ref.slice(2).split("/").reduce((node, key) => node[key], doc);
const settled = (node) => (node.$ref ? at(node.$ref) : node);

test("asyncapi.yaml is a valid AsyncAPI document", () => {
  const schema = createRequire(import.meta.url)(`@asyncapi/specs/schemas/${doc.asyncapi}-without-$id.json`);
  const valid = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
  assert.ok(valid(doc), JSON.stringify(valid.errors, null, 2));
});

test("every event has a description, a payload schema and an example that fits it", async () => {
  const described = await describedEvents(); // empty for an app that publishes nothing (channels: {})
  for (const [key, channel] of Object.entries(doc.channels ?? {})) {
    const event = channel.address ?? key;
    if (!described.has(event)) continue; // a channel this app only receives from
    assert.ok(channel.description, `${event}: say what it means (channels.${key}.description)`);
    const message = settled(Object.values(channel.messages)[0]);
    assert.ok(message.payload, `${event}: its message needs a payload schema`);
    assert.ok(message.examples?.length, `${event}: give an example, which other apps see`);
    for (const example of message.examples) assert.equal(await publish(event, example.payload), null, "fits; nothing is sent off the platform");
  }
});

test("an event that is not described, or a payload that does not fit, is refused", async () => {
  const [event] = (await describedEvents()).keys();
  await assert.rejects(publish("not-described", {}), EventInvalid);
  if (event) await assert.rejects(publish(event, { unexpected: true }), /does not fit its schema in asyncapi.yaml/);
});

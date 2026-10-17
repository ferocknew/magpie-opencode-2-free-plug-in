import assert from "node:assert/strict";
import test from "node:test";
import { opencodeID, realSessionID, sessionID } from "./provider.mjs";

// --- identity and session ids -------------------------------------------

test("opencodeID makes a descending session id of OpenCode 2's shape", () => {
  const now = 1792208641000;
  const id = opencodeID("ses", true, now);
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  // The counter is bit-inverted, so the low 12 bits hold a small number.
  assert.ok(realSessionID(id), `not a real session id: ${id}`);
  const raw = ~BigInt(`0x${id.slice(4, 16)}`) & 0xffffffffffffn;
  assert.equal(raw & 0xfffn, 1n);
  const plain = (BigInt(now) * 0x1000n + 1n) & 0xffffffffffffn;
  assert.equal(raw, plain);
});

test("opencodeID makes an ascending request id", () => {
  const now = 1792208642000;
  const id = opencodeID("msg", false, now);
  assert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  const value = BigInt(`0x${id.slice(4, 16)}`);
  assert.equal(value & 0xfffn, 1n);
  assert.equal(value, (BigInt(now) * 0x1000n + 1n) & 0xffffffffffffn);
});

test("realSessionID refuses ids the gateway would refuse", () => {
  const now = Date.now();
  assert.equal(realSessionID(opencodeID("ses", true, now)), true);
  assert.equal(realSessionID(opencodeID("ses", false, now)), false);
  assert.equal(realSessionID(`ses_${"a".repeat(12)}${"b".repeat(14)}`), false);
  assert.equal(realSessionID("ses_eb822f3a3ffeQgpvRPUxQS3wBt"), true);
  assert.equal(realSessionID(crypto.randomUUID()), false);
  assert.equal(realSessionID(undefined), false);
});

test("sessionID keeps one made-up session per conversation", () => {
  const body = { messages: [{ role: "user", content: "one conversation" }] };
  const first = sessionID(new Headers(), body);
  const second = sessionID(new Headers(), body);
  assert.equal(first, second);
  assert.ok(realSessionID(first));
  assert.notEqual(sessionID(new Headers(), { messages: [{ role: "user", content: "other" }] }), first);
});

test("sessionID passes a real session id through", () => {
  const real = opencodeID("ses", true);
  const headers = new Headers({ "x-opencode-session": real });
  assert.equal(sessionID(headers, { messages: [] }), real);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fixture, PUBLIC_AUTH, sse } from "./test_helpers.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardResponse } from "./tool-response.mjs";

// --- collapse response ---------------------------------------------------

test("a non-streaming caller gets a collapsed JSON reply", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.reply =
    'data: {"id":"chat-1","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n' +
    'data: {"id":"chat-1","model":"big-pickle","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
    "data: [DONE]\n\n";
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.headers.get("content-type"), "application/json");
  const value = await response.json();
  assert.equal(value.object, "chat.completion");
  assert.equal(value.choices[0].message.content, "hello");
  assert.equal(value.choices[0].finish_reason, "stop");
  assert.equal(value.usage.prompt_tokens, 3);
});

test("reasoning_content survives the collapse", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.reply =
    'data: {"id":"r-1","model":"glm-5.3-flash-free","choices":[{"index":0,"delta":{"reasoning_content":"think "}}]}\n\n' +
    'data: {"id":"r-1","model":"glm-5.3-flash-free","choices":[{"index":0,"delta":{"reasoning_content":"more","content":"answer"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }),
  });
  const value = await response.json();
  assert.equal(value.choices[0].message.reasoning_content, "think more");
  assert.equal(value.choices[0].message.content, "answer");
});

test("collapseResponse keeps tool calls and usage", async () => {
  const response = new Response(
    sse([
      { id: "c-1", model: "big-pickle", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "Bash", arguments: "" } }] } }] },
      { id: "c-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
      { id: "c-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
  const collapsed = await collapseResponse(response);
  const value = await collapsed.json();
  assert.equal(value.choices[0].message.tool_calls[0].function.name, "Bash");
  assert.equal(value.choices[0].message.tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.equal(value.choices[0].finish_reason, "tool_calls");
  assert.equal(value.usage.completion_tokens, 4);
});

test("collapseResponse fails a stream with no completion marker", async () => {
  const response = new Response(
    'data: {"id":"c-2","choices":[{"index":0,"delta":{"content":"half"}}]}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
  const collapsed = await collapseResponse(response);
  assert.equal(collapsed.status, 502);
  const value = await collapsed.json();
  assert.match(value.error.message, /completion marker/);
});

test("collapseResponse leaves a plain JSON reply alone", async () => {
  const response = new Response('{"ok":true}', {
    headers: { "content-type": "application/json" },
  });
  assert.equal(await collapseResponse(response).then((r) => r.text()), '{"ok":true}');
});

// --- stream framing and cut short streams --------------------------------

test("a stream cut short still ends as an answer", async () => {
  const response = new Response(
    'data: {"id":"chat-5","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
  const guarded = await guardResponse(response, { declared: new Set(["Bash"]) }, { endCutShort: true });
  const text = await guarded.text();
  assert.match(text, /partial/);
  assert.match(text, /cut short/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /\[DONE\]/);
});

test("a stream cut short with nothing said fails", async () => {
  const response = new Response(": keep-alive\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  const guarded = await guardResponse(response, { declared: new Set(["Bash"]) }, { endCutShort: true });
  const text = await guarded.text();
  assert.match(text, /ended without a completion marker/);
  assert.doesNotMatch(text, /\[DONE\]/);
});

test("an upstream error event is passed on", async () => {
  const response = new Response(
    'data: {"error":{"type":"server_error","message":"upstream overloaded"}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
  const guarded = await guardResponse(response, { declared: new Set(["Bash"]) });
  const text = await guarded.text();
  assert.match(text, /upstream overloaded/);
});

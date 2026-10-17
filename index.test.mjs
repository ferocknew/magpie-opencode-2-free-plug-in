import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { OpenCode2FreePlugin, default as plugin } from "./index.mjs";
import { PRESET_IDS, USER_AGENT, buildModels, isFreeId } from "./models.mjs";
import { opencodeID, realSessionID, sessionID } from "./provider.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardResponse, nameGuard, normalizeTools } from "./tool-response.mjs";

const PUBLIC_AUTH = async () => ({ type: "api", key: "public" });

// A fake gateway: the model list, the catalog, and a chat endpoint that
// answers with whatever the test put in state.reply.
async function fixture(t, input = {}, options = {}) {
  const state = { calls: [], reply: null, status: 200, contentType: "text/event-stream" };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    state.calls.push({
      url: req.url,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    if (req.url === "/inference/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            ...PRESET_IDS,
            "jev-1.13-free",
            "test",
            "some-paid-model",
          ].map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }
    if (req.url === "/catalog.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ opencode: { models: state.catalogModels ?? {} } }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (state.reply != null) {
        res.writeHead(state.status, { "content-type": state.contentType });
        res.end(state.reply);
        return;
      }
      res.writeHead(state.status, { "content-type": state.contentType });
      res.end(
        'data: {"id":"chat-1","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hooks = await OpenCode2FreePlugin(input, {
    baseURL: `${origin}/v1`,
    modelsURL: `${origin}/inference/v1/models`,
    catalogURL: `${origin}/catalog.json`,
    ...options,
  });
  return { hooks, state, origin };
}

function sse(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

// --- identity and session ids -------------------------------------------

test("plugin exports a server function under both names", () => {
  assert.equal(typeof OpenCode2FreePlugin, "function");
  assert.equal(plugin.id, "opencode-2-free");
  assert.equal(plugin.server, OpenCode2FreePlugin);
});

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

// --- model metadata ------------------------------------------------------

test("preset models cover the ten free models OpenCode 2.0.31 offers", () => {
  const expected = [
    "glm-5.3-flash-free",
    "deepseek-v4.1-flash-free",
    "big-pickle",
    "beam-free",
    "nemotron-3.5-super-vl-free",
    "space-bunny-free",
    "mimo-v2.6-flash-free",
    "nemotron-3.5-lightning-free",
    "nemotron-3-ultra-free",
    "longcat-2.5-preview-free",
  ];
  assert.deepEqual(PRESET_IDS.sort(), expected.sort());
});

test("every preset is free, reasoning and tool-calling", () => {
  const models = buildModels(PRESET_IDS);
  assert.equal(Object.keys(models).length, PRESET_IDS.length);
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id);
    assert.equal(model.providerID, "opencode-2-free");
    assert.equal(model.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(model.cost.input, 0);
    assert.equal(model.cost.output, 0);
    assert.equal(model.capabilities.reasoning, true);
    assert.equal(model.capabilities.toolcall, true);
    assert.equal(model.capabilities.interleaved.field, "reasoning_content");
    assert.ok(Number.isInteger(model.limit.context), `bad context limit for ${id}`);
    assert.ok(model.limit.context > 0);
  }
});

test("multimodal models say which inputs they take", () => {
  const models = buildModels(PRESET_IDS);
  assert.equal(models["glm-5.3-flash-free"].capabilities.input.image, true);
  assert.equal(models["glm-5.3-flash-free"].capabilities.input.pdf, true);
  assert.equal(models["mimo-v2.6-flash-free"].capabilities.input.audio, true);
  assert.equal(models["space-bunny-free"].capabilities.input.video, true);
  assert.equal(models["deepseek-v4.1-flash-free"].capabilities.input.image, true);
  assert.equal(models["big-pickle"].capabilities.input.image, false);
  assert.equal(models["nemotron-3-ultra-free"].capabilities.input.image, false);
  assert.equal(models["big-pickle"].capabilities.attachment, false);
});

test("reasoning efforts become variants", () => {
  const models = buildModels(PRESET_IDS);
  assert.deepEqual(Object.keys(models["glm-5.3-flash-free"].variants), ["low", "high", "max"]);
  assert.deepEqual(models["nemotron-3.5-super-vl-free"].variants.minimal, {
    reasoningEffort: "minimal",
  });
  assert.deepEqual(models["big-pickle"].variants, {});
});

test("free detection follows the catalog and refuses non-chat entries", () => {
  assert.equal(isFreeId("glm-5.3-flash-free", {}), true);
  assert.equal(isFreeId("big-pickle", {}), true);
  assert.equal(isFreeId("some-paid-model", {}), false);
  assert.equal(isFreeId("test", {}), false);
  assert.equal(isFreeId("jev-1.13-free", {}), false);
  assert.equal(
    isFreeId("priced-model-free", { "priced-model-free": { cost: { input: 3, output: 10 } } }),
    false,
  );
  assert.equal(
    isFreeId("listed-free", { "listed-free": { cost: { input: 0, output: 0 } } }),
    true,
  );
  assert.equal(
    isFreeId("retired-free", { "retired-free": { cost: { input: 0, output: 0 }, deprecated: true } }),
    false,
  );
});

test("catalog metadata overrides presets", () => {
  const models = buildModels(
    ["big-pickle"],
    { "big-pickle": { name: "Big Pickle Live", limit: { context: 1234, output: 567 } } },
  );
  assert.equal(models["big-pickle"].name, "Big Pickle Live");
  assert.equal(models["big-pickle"].limit.context, 1234);
  assert.equal(models["big-pickle"].limit.output, 567);
});

// --- request construction ------------------------------------------------

test("config declares the provider with its models", async (t) => {
  const { hooks } = await fixture(t);
  const cfg = { provider: {} };
  await hooks.config(cfg);
  const provider = cfg.provider["opencode-2-free"];
  assert.equal(provider.name, "OpenCode 2 Free");
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(Object.keys(provider.models).length, PRESET_IDS.length);
  assert.equal(provider.models["big-pickle"].cost.input, 0);
  assert.equal(provider.models["big-pickle"].reasoning, true);
});

test("auth offers the public key and accepts any typed key", async (t) => {
  const { hooks } = await fixture(t);
  assert.equal(hooks.auth.methods[0].type, "api");
  assert.deepEqual(await hooks.auth.methods[0].authorize(), {
    type: "success",
    key: "public",
  });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "my-own-key" }));
  assert.equal(loader.apiKey, "public");
});

test("the request carries OpenCode 2's identity, a session and a request id", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "big-pickle",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const call = state.calls.find((entry) => entry.url === "/v1/chat/completions");
  assert.ok(call, "chat request must have been sent");
  assert.equal(call.headers["user-agent"], USER_AGENT);
  assert.equal(call.headers["x-opencode-client"], "cli");
  assert.equal(call.headers.authorization, "Bearer public");
  assert.ok(realSessionID(call.headers["x-opencode-session"]));
  assert.equal(call.headers["x-opencode-session-id"], call.headers["x-opencode-session"]);
  assert.match(call.headers["x-opencode-request"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(call.headers["x-opencode-project"], "global");
});

test("the request always streams and carries all five core tools", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "big-pickle",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object", properties: { filePath: { type: "string" } } },
          },
        },
      ],
    }),
  });
  await response.text();
  const body = state.calls.find((entry) => entry.url === "/v1/chat/completions").body;
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const names = body.tools.map((tool) => tool.function.name);
  for (const name of ["bash", "edit", "glob", "grep", "read"]) {
    assert.ok(names.includes(name), `missing core tool ${name}`);
  }
  assert.ok(names.includes("Read"), "the agent's own tool must be kept");
  const bash = body.tools.find((tool) => tool.function.name === "bash");
  assert.equal(bash.function.parameters.properties.command.type, "string");
  const read = body.tools.find((tool) => tool.function.name === "read");
  assert.equal(read.function.parameters.properties.filePath.type, "string");
});

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

test("an unknown model is refused with the free list", async (t) => {
  const { hooks, origin } = await fixture(t);
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 404);
  const value = await response.json();
  assert.match(value.error.message, /not an OpenCode 2 free model/);
  assert.match(value.error.message, /big-pickle/);
});

test("another endpoint is refused", async (t) => {
  const { hooks, origin } = await fixture(t);
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  await assert.rejects(
    loader.fetch(`${origin}/v1/responses`, { method: "POST", body: "{}" }),
    /Unsupported OpenCode 2 Free endpoint/,
  );
});

// --- discovery -----------------------------------------------------------

test("provider.models lists the free models and drops test/jev", async (t) => {
  const { hooks } = await fixture(t);
  const models = await hooks.provider.models({ models: {} }, { auth: await PUBLIC_AUTH() });
  assert.equal(Object.keys(models).length, PRESET_IDS.length);
  assert.equal(models["test"], undefined);
  assert.equal(models["jev-1.13-free"], undefined);
  assert.equal(models["some-paid-model"], undefined);
});

test("provider.models without auth keeps the config's models", async (t) => {
  const { hooks } = await fixture(t);
  const provider = { models: { existing: { id: "existing" } } };
  assert.equal(await hooks.provider.models(provider, {}), provider.models);
});

test("chat.headers passes the host's session to the loader", async (t) => {
  const { hooks } = await fixture(t);
  const output = { headers: {} };
  await hooks["chat.headers"](
    { model: { providerID: "opencode-2-free" }, sessionID: "ses_real" },
    output,
  );
  assert.equal(output.headers["x-magpie-opencode2-session"], "ses_real");
  const other = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "other" }, sessionID: "ses_real" }, other);
  assert.deepEqual(other.headers, {});
});

// --- tool guard ----------------------------------------------------------

test("normalizeTools adds the core tools and answers the declared names", () => {
  const body = {
    tools: [
      {
        type: "function",
        function: { name: "Bash", parameters: { type: "object", properties: {} } },
      },
    ],
  };
  const policy = normalizeTools(body);
  assert.deepEqual([...policy.declared], ["Bash"]);
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    ["Bash", "bash", "edit", "glob", "grep", "read"],
  );
});

test("nameGuard renames OpenCode's tool names to the agent's", () => {
  const guard = nameGuard({ declared: ["Bash", "Read", "todo_write"] });
  assert.equal(guard("bash"), "Bash");
  assert.equal(guard("Bash"), "Bash");
  assert.equal(guard("read"), "Read");
  assert.equal(guard("todowrite"), "todo_write");
  assert.equal(guard("nope"), null);
  assert.equal(guard(""), null);
  assert.equal(guard(undefined), null);
});

test("nameGuard never guesses between two tools that fold alike", () => {
  const guard = nameGuard({ declared: ["todo_write", "todo-write"] });
  assert.equal(guard("todowrite"), null);
});

test("streamed tool calls come out renamed to the agent's tools", async () => {
  const response = new Response(
    sse([
      {
        id: "chat-1",
        model: "big-pickle",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: "" } }] } }],
      },
      {
        id: "chat-1",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }],
      },
      { id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
  const guarded = await guardResponse(response, { declared: new Set(["Bash", "read"]) });
  const text = await guarded.text();
  assert.match(text, /"name":"Bash"/);
  assert.doesNotMatch(text, /"name":"bash"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /\[DONE\]/);
});

test("a call of a tool the agent lacks is left out with a note", async () => {
  const response = new Response(
    sse([
      {
        id: "chat-2",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "webfetch", arguments: "{}" } }] } }],
      },
      { id: "chat-2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
  const guarded = await guardResponse(response, { declared: new Set(["Bash"]) });
  const text = await guarded.text();
  assert.doesNotMatch(text, /"tool_calls"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /doesn't have/);
  assert.match(text, /webfetch/);
});

test("text survives a left-out call and the reply still ends", async () => {
  const response = new Response(
    sse([
      { id: "chat-3", choices: [{ index: 0, delta: { content: "Here you go." } }] },
      {
        id: "chat-3",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "zzz", arguments: "{}" } }] } }],
      },
      { id: "chat-3", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
  const guarded = await guardResponse(response, { declared: new Set(["Bash"]) });
  const text = await guarded.text();
  assert.match(text, /Here you go\./);
  assert.match(text, /left out/);
  assert.match(text, /"finish_reason":"stop"/);
});

test("a whole non-streamed reply is guarded too", async () => {
  const response = new Response(
    JSON.stringify({
      id: "chat-4",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"a"}' } },
              { id: "c2", type: "function", function: { name: "webfetch", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
  const guarded = await guardResponse(response, { declared: new Set(["Read"]) });
  const value = await guarded.json();
  assert.equal(value.choices[0].message.tool_calls.length, 1);
  assert.equal(value.choices[0].message.tool_calls[0].function.name, "Read");
  assert.match(value.choices[0].message.content, /webfetch/);
});

// --- stream end and errors ----------------------------------------------

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

test("a 403 reply is passed through untouched", async () => {
  const response = new Response('{"type":"error","error":{"type":"FreeTierError"}}', {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  const guarded = await guardResponse(response, { declared: new Set() });
  assert.equal(guarded.status, 403);
  assert.match(await guarded.text(), /FreeTierError/);
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

// --- end to end ----------------------------------------------------------

test("an end-to-end streamed turn reaches the caller with reasoning", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.reply = sse([
    {
      id: "chat-9",
      model: "glm-5.3-flash-free",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "The user greets me.",
            content: "Hi!",
          },
          finish_reason: "stop",
        },
      ],
    },
  ]);
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "glm-5.3-flash-free",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /reasoning_content/);
  assert.match(text, /The user greets me\./);
  assert.match(text, /\[DONE\]/);
});

test("a 403 from the gateway reaches the caller as-is", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.reply = '{"type":"error","error":{"type":"FreeTierError","message":"only within OpenCode"}}';
  state.status = 403;
  state.contentType = "application/json";
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 403);
});

test("the public credential is used whatever key was stored", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "sk-personal" }));
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();
  const call = state.calls.find((entry) => entry.url === "/v1/chat/completions");
  assert.equal(call.headers.authorization, "Bearer public");
});

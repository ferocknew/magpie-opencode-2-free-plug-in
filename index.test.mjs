import assert from "node:assert/strict";
import test from "node:test";
import { OpenCode2FreePlugin, default as plugin } from "./index.mjs";
import { PRESET_IDS, USER_AGENT } from "./models.mjs";
import { realSessionID } from "./provider.mjs";
import { fixture, PUBLIC_AUTH, sse } from "./test_helpers.mjs";

test("plugin exports a server function under both names", () => {
  assert.equal(typeof OpenCode2FreePlugin, "function");
  assert.equal(plugin.id, "opencode-2-free");
  assert.equal(plugin.server, OpenCode2FreePlugin);
});

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

test("the request carries OpenCode 2's identity, a session and session affinity", async (t) => {
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
  assert.equal(call.headers["user-agent"], "opencode/latest/2.0.31/cli");
  assert.equal(call.headers["user-agent"], USER_AGENT);
  assert.equal(call.headers["x-opencode-client"], "cli");
  assert.equal(call.headers.authorization, "Bearer public");
  const session = call.headers["x-opencode-session"];
  assert.ok(realSessionID(session));
  assert.equal(call.headers["x-opencode-session-id"], session);
  assert.equal(call.headers["x-session-affinity"], session);
  assert.equal(call.headers["x-session-id"], session);
  assert.equal(call.headers["x-opencode-request"], undefined);
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

// --- reasoning effort: max first, high fallback --------------------------

test("upgrades reasoning_effort high to max when upstream accepts max", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.reply = sse([{ id: "chat-10", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash-free", stream: true, reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  const call = state.calls.find((entry) => entry.url === "/v1/chat/completions");
  assert.equal(call.body.reasoning_effort, "max");
});

test("falls back to reasoning_effort high when upstream refuses max", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.status = 429;
  state.reply = '{"error":{"message":"Endpoint unavailable"}}';
  state.contentType = "application/json";

  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  state.onCall = (call) => {
    if (call.url !== "/v1/chat/completions") return;
    if (call.body.reasoning_effort === "max") {
      state.status = 429;
      state.reply = '{"error":{"message":"Endpoint unavailable"}}';
    } else {
      state.status = 200;
      state.contentType = "text/event-stream";
      state.reply = sse([{ id: "chat-11", choices: [{ index: 0, delta: { content: "ok fallback" }, finish_reason: "stop" }] }]);
    }
  };

  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash-free", stream: true, reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /ok fallback/);
  const calls = state.calls.filter((entry) => entry.url === "/v1/chat/completions");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.reasoning_effort, "max");
  assert.equal(calls[1].body.reasoning_effort, "high");
});

// --- a cold upstream -----------------------------------------------------

test("a 503 is sent again until the upstream answers", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  let chat = 0;
  state.onCall = (call) => {
    if (call.url !== "/v1/chat/completions") return;
    chat += 1;
    if (chat < 3) {
      state.status = 503;
      state.contentType = "application/json";
      state.reply =
        '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}';
    } else {
      state.status = 200;
      state.contentType = "text/event-stream";
      state.reply = sse([
        { id: "chat-12", choices: [{ index: 0, delta: { content: "awake" }, finish_reason: "stop" }] },
      ]);
    }
  };
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
  assert.match(await response.text(), /awake/);
  assert.equal(chat, 3, "the two 503s must have been sent again");
});

test("a 5xx that never clears is given to the caller", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.status = 503;
  state.contentType = "application/json";
  state.reply = '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}';
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 503);
  const calls = state.calls.filter((entry) => entry.url === "/v1/chat/completions");
  assert.equal(calls.length, 8, "the first try and seven retries");
});

test("a session that keeps failing is replaced", async (t) => {
  const { hooks, state, origin } = await fixture(t);
  state.status = 503;
  state.contentType = "application/json";
  state.reply =
    '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}';
  const loader = await hooks.auth.loader(PUBLIC_AUTH);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 503);
  const sessions = state.calls
    .filter((entry) => entry.url === "/v1/chat/completions")
    .map((entry) => entry.headers["x-opencode-session"]);
  assert.equal(sessions.length, 8);
  assert.equal(sessions[0], sessions[1], "the conversation's session is kept for the first tries");
  assert.notEqual(sessions[2], sessions[1], "a new session is made after them");
  assert.equal(new Set(sessions.slice(2)).size, sessions.length - 2, "every later try gets its own");
  for (const entry of state.calls.filter((call) => call.url === "/v1/chat/completions")) {
    assert.equal(entry.headers["x-opencode-session-id"], entry.headers["x-opencode-session"]);
    assert.equal(entry.headers["x-session-affinity"], entry.headers["x-opencode-session"]);
    assert.equal(entry.headers["x-session-id"], entry.headers["x-opencode-session"]);
  }
});

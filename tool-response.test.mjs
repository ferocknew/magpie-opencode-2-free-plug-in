import assert from "node:assert/strict";
import test from "node:test";
import { sse } from "./test_helpers.mjs";
import { guardResponse, nameGuard, normalizeTools } from "./tool-response.mjs";

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

test("a 403 reply is passed through untouched", async () => {
  const response = new Response('{"type":"error","error":{"type":"FreeTierError"}}', {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  const guarded = await guardResponse(response, { declared: new Set() });
  assert.equal(guarded.status, 403);
  assert.match(await guarded.text(), /FreeTierError/);
});

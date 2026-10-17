// Tool stand-ins and reply guards.
//
// OpenCode 2's free tier answers 403 FreeTierError unless the request
// carries a `read` tool (a request with only bash/edit/glob/grep is turned
// away) and `stream: true`. Requests are therefore sent with all five core
// OpenCode tools, described as unavailable when the agent did not declare
// them.
//
// Models answer with OpenCode's own tool names whatever the agent declared
// (`bash` when the agent has `Bash`, `todowrite` when it has `todo_write`).
// A call is renamed to the agent's tool whose name differs only in case, or
// else only in case and separators, when exactly one does. A call of a tool
// the agent does not have is left out, and the reply's text says so.

const encoder = new TextEncoder();

const CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"];

const string = (description) => ({ type: "string", description });

const CORE_SCHEMAS = {
  bash: {
    type: "object",
    properties: {
      command: string("The command to run"),
      description: string("What the command does"),
      timeout: { type: "number", description: "Timeout in milliseconds" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  edit: {
    type: "object",
    properties: {
      filePath: string("The file to edit"),
      oldString: string("The text to replace"),
      newString: string("The replacement text"),
      replaceAll: { type: "boolean", description: "Replace every occurrence" },
    },
    required: ["filePath", "oldString", "newString"],
    additionalProperties: false,
  },
  glob: {
    type: "object",
    properties: {
      pattern: string("The glob pattern"),
      path: string("The directory to search in"),
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  grep: {
    type: "object",
    properties: {
      pattern: string("The regular expression to search for"),
      path: string("The directory to search in"),
      include: string("The file pattern to include"),
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  read: {
    type: "object",
    properties: {
      filePath: string("The file to read"),
      offset: { type: "number", description: "The line to start at" },
      limit: { type: "number", description: "How many lines to read" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
};

// normalizeTools fills the request with the core tools the agent did not
// declare and answers the names the agent did declare, for the reply guard.
export function normalizeTools(body) {
  if (body.tools != null && !Array.isArray(body.tools)) throw new Error("tools must be an array");
  body.tools ??= [];
  const present = new Set(
    body.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string"),
  );
  const declared = new Set(present);
  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      function: {
        name,
        description: "Not available. Never call this tool.",
        parameters: CORE_SCHEMAS[name],
      },
    });
  }
  return { declared };
}

const separators = /[\s_.-]/g;

function foldsTo(declared, key) {
  const folded = new Map();
  for (const name of declared) {
    const k = key(name);
    if (!k) continue;
    folded.set(k, folded.has(k) ? null : name);
  }
  return folded;
}

export function nameGuard(policy) {
  const declared = new Set(policy.declared);
  const lower = (name) => name.toLowerCase();
  const bare = (name) => name.toLowerCase().replace(separators, "");
  const byCase = foldsTo(declared, lower);
  const byShape = foldsTo(declared, bare);
  return (name) => {
    if (typeof name !== "string" || !name) return null;
    if (declared.has(name)) return name;
    const caseKey = lower(name);
    const match = byCase.get(caseKey) ?? (byCase.has(caseKey) ? null : byShape.get(bare(name)));
    return match || null;
  };
}

export function droppedNote(name) {
  return typeof name === "string" && name
    ? `(The model called a tool this agent doesn't have: ${JSON.stringify(name.slice(0, 128))}. The call was left out.)`
    : "(The model called a tool without a name. The call was left out.)";
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function position(value) {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid tool index");
  return result;
}

function append(target, fragment) {
  if (!object(fragment)) throw new Error("Invalid tool delta");
  for (const key of ["name", "arguments"]) {
    if (typeof fragment[key] === "string") target[key] = (target[key] ?? "") + fragment[key];
  }
}

function collect(delta, calls) {
  for (const fragment of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
    if (!object(fragment)) throw new Error("Invalid tool delta");
    const index = position(fragment.index);
    const call = calls.get(index) ?? {
      index,
      type: "function",
      function: { name: "", arguments: "" },
    };
    for (const key of ["id", "type"]) {
      if (fragment[key] !== undefined) call[key] = fragment[key];
    }
    if (fragment.function) append(call.function, fragment.function);
    calls.set(index, call);
  }
  if (delta?.function_call) {
    const call = calls.get(0) ?? {
      index: 0,
      type: "function",
      function: { name: "", arguments: "" },
    };
    append(call.function, delta.function_call);
    calls.set(0, call);
  }
}

// resolve renames or drops the buffered calls and answers the calls to
// send, plus the notes for those left out.
function resolve(calls, checkName) {
  const kept = [];
  const notes = [];
  for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
    const name = checkName(call.function?.name);
    if (name == null) {
      notes.push(droppedNote(call.function?.name));
      continue;
    }
    call.function.name = name;
    kept.push({ ...call, index: kept.length });
  }
  return { calls: kept, notes };
}

function appendText(delta, text) {
  return { ...delta, content: (typeof delta.content === "string" ? delta.content : "") + text };
}

// guardChatValue guards a whole chat.completion body (a reply that came
// back as plain JSON, not as a stream).
export function guardChatValue(value, checkName) {
  for (const choice of Array.isArray(value?.choices) ? value.choices : []) {
    const message = choice?.message;
    if (!object(message)) continue;
    if (message.function_call != null) {
      const name = checkName(message.function_call.name);
      if (name == null) {
        message.content = (message.content ?? "") + droppedNote(message.function_call.name);
        delete message.function_call;
        if (choice.finish_reason === "function_call") choice.finish_reason = "stop";
      } else {
        message.function_call.name = name;
      }
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = new Map();
      for (const [index, call] of message.tool_calls.entries()) {
        calls.set(index, {
          ...call,
          index,
          function: {
            ...call?.function,
            name: call?.function?.name ?? "",
            arguments: call?.function?.arguments ?? "",
          },
        });
      }
      const result = resolve(calls, checkName);
      if (result.calls.length) message.tool_calls = result.calls;
      else delete message.tool_calls;
      if (result.notes.length) {
        message.content = (message.content ?? "") + result.notes.join("\n\n");
        if (!result.calls.length && ["tool_calls", "function_call"].includes(choice.finish_reason)) {
          choice.finish_reason = "stop";
        }
      }
    }
  }
  return value;
}

export function encodeEvent(data, name = "") {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function failureFrame(message) {
  return encodeEvent({ error: { type: "upstream_error", message } });
}

async function* parseFrames(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield raw;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

function parseFrame(raw) {
  let name = "";
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let content = colon < 0 ? "" : line.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") name = content;
    if (field === "data") data.push(content);
  }
  return { name, text: data.join("\n") };
}

function guardedStream(reader, checkName, endCutShort) {
  const frames = parseFrames(reader);
  const states = new Map();
  let meta = null;
  let said = false;
  let completed = false;

  function stateFor(index) {
    if (!states.has(index)) {
      states.set(index, { calls: new Map(), wrote: false, finished: false });
    }
    return states.get(index);
  }

  function apply(data) {
    if (!object(data)) return { data, changed: false };
    if (data.id !== undefined || data.created !== undefined || data.model !== undefined) {
      meta ??= {};
      for (const key of ["id", "created", "model"]) {
        if (data[key] !== undefined) meta[key] = data[key];
      }
    }
    let changed = false;
    for (const choice of Array.isArray(data.choices) ? data.choices : []) {
      if (!object(choice)) continue;
      const state = stateFor(position(choice.index));
      const delta = object(choice.delta) ? choice.delta : {};
      for (const key of ["content", "reasoning_content", "reasoning"]) {
        if (typeof delta[key] === "string" && delta[key]) said = true;
      }
      if (typeof delta.content === "string" && delta.content) state.wrote = true;
      if (delta.tool_calls != null || delta.function_call != null) {
        collect(delta, state.calls);
        delete delta.tool_calls;
        delete delta.function_call;
        changed = true;
      }
      if (choice.finish_reason != null) {
        state.finished = true;
        const buffered = state.calls;
        state.calls = new Map();
        if (!buffered.size) continue;
        changed = true;
        const result = resolve(buffered, checkName);
        const lead = state.wrote && result.notes.length ? "\n\n" : "";
        if (result.calls.length) {
          choice.delta = { ...delta, tool_calls: result.calls };
          if (result.notes.length) {
            choice.delta = appendText(choice.delta, lead + result.notes.join("\n\n"));
          } else if (choice.finish_reason === "function_call") {
            choice.finish_reason = "tool_calls";
          }
        } else {
          choice.delta = appendText(delta, lead + result.notes.join("\n\n"));
          choice.finish_reason = "stop";
        }
      }
    }
    return { data, changed };
  }

  // pendingCalls flushes calls a gateway never gave a finish_reason for.
  function pendingChunk() {
    const choices = [];
    for (const [index, state] of [...states].sort(([a], [b]) => a - b)) {
      if (state.finished || !state.calls.size) continue;
      const result = resolve(state.calls, checkName);
      state.calls = new Map();
      const lead = state.wrote && result.notes.length ? "\n\n" : "";
      choices.push({
        index,
        delta: {
          ...(result.calls.length ? { tool_calls: result.calls } : {}),
          ...(result.notes.length ? { content: lead + result.notes.join("\n\n") } : {}),
        },
        finish_reason: result.calls.length ? "tool_calls" : "stop",
      });
    }
    if (!choices.length) return "";
    return encodeEvent({
      id: meta?.id ?? "chatcmpl-guard",
      object: "chat.completion.chunk",
      created: meta?.created ?? Math.floor(Date.now() / 1000),
      model: meta?.model ?? "",
      choices,
    });
  }

  function cutShortEnd() {
    const choices = [];
    for (const [index, state] of [...states].sort(([a], [b]) => a - b)) {
      if (state.finished) continue;
      choices.push({
        index,
        delta: {
          content:
            (state.wrote ? "\n\n" : "") +
            "(The reply was cut short by the gateway. Ask again to go on.)",
        },
        finish_reason: "stop",
      });
    }
    const head = choices.length
      ? encodeEvent({
          id: meta?.id ?? "chatcmpl-cut-short",
          object: "chat.completion.chunk",
          created: meta?.created ?? Math.floor(Date.now() / 1000),
          model: meta?.model ?? "",
          choices,
        })
      : "";
    return head + "data: [DONE]\n\n";
  }

  let stopped = false;
  return new ReadableStream(
    {
      async pull(controller) {
        if (stopped) return;
        try {
          const next = await frames.next();
          if (next.done) {
            stopped = true;
            if (completed) {
              controller.close();
              return;
            }
            if (endCutShort && said) {
              controller.enqueue(encoder.encode(cutShortEnd()));
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(
                failureFrame("Upstream stream ended without a completion marker"),
              ),
            );
            controller.close();
            return;
          }
          const { name, text } = parseFrame(next.value);
          if (!text.trim()) {
            controller.enqueue(encoder.encode(`${next.value}\n\n`));
            return;
          }
          if (text.trim() === "[DONE]") {
            completed = true;
            controller.enqueue(encoder.encode(pendingChunk() + "data: [DONE]\n\n"));
            return;
          }
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            stopped = true;
            controller.enqueue(encoder.encode(failureFrame("Invalid JSON in upstream stream")));
            controller.close();
            return;
          }
          if (data?.error || name === "error") {
            stopped = true;
            const message = data?.error?.message ?? data?.message ?? "Upstream stream failed";
            controller.enqueue(encoder.encode(failureFrame(String(message))));
            controller.close();
            return;
          }
          const result = apply(data);
          controller.enqueue(encoder.encode(result.changed ? encodeEvent(result.data) : `${next.value}\n\n`));
        } catch (error) {
          stopped = true;
          controller.enqueue(
            encoder.encode(failureFrame(error?.message ?? "Upstream stream failed")),
          );
          controller.close();
        }
      },
      async cancel() {
        stopped = true;
        try {
          await frames.return?.();
        } finally {
          reader.releaseLock?.();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

// guardResponse guards tool calls in a chat reply: names renamed to the
// agent's, calls it has no tool for left out with a note. options.endCutShort
// lets a stream the gateway closed early end as a cut-short answer.
export async function guardResponse(response, policy, options = {}) {
  if (!response.ok) return response;
  const checkName = nameGuard(policy);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "text/event-stream" && response.body) {
    return new Response(guardedStream(response.body.getReader(), checkName, options.endCutShort === true), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    headers.set("content-type", "application/json");
    return new Response(failureFrame("Invalid JSON in upstream response"), { status: 502, headers });
  }
  guardChatValue(value, checkName);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { status: response.status, headers });
}

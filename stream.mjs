// Non-streaming aggregation: the gateway's free tier only answers a
// streaming (SSE) request, so a caller that asked for stream:false gets its
// stream collapsed into one chat.completion body here.

const MAX_BYTES = 32 * 1024 * 1024;

function headersFor(response) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return headers;
}

function errorMessage(value, fallback = "Upstream stream failed") {
  if (typeof value === "string" && value) return value;
  return value?.message || value?.error?.message || fallback;
}

function index(value) {
  const result = value ?? 0;
  if (!Number.isInteger(result) || result < 0 || result > 65535) {
    throw new Error("Invalid stream item index");
  }
  return result;
}

function sorted(map) {
  return [...map].sort(([a], [b]) => a - b).map(([, value]) => value);
}

function appendFunction(target, delta) {
  for (const key of ["name", "arguments"]) {
    if (typeof delta[key] === "string") target[key] = (target[key] ?? "") + delta[key];
  }
}

export function chatAccumulator() {
  const body = { object: "chat.completion", choices: [] };
  const choices = new Map();
  const tools = new Map();
  const extraChoices = new Map();
  return {
    apply(data) {
      for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
        if (data[key] !== undefined) body[key] = data[key];
      }
      if (data.usage) body.usage = { ...body.usage, ...data.usage };
      if (data.error) throw new Error(errorMessage(data.error));
      for (const part of data.choices ?? []) {
        const position = index(part.index);
        if (!choices.has(position)) {
          choices.set(position, {
            index: position,
            message: { role: "assistant", content: null },
            finish_reason: null,
          });
          tools.set(position, new Map());
          extraChoices.set(position, {});
        }
        const choice = choices.get(position);
        const extra = extraChoices.get(position);
        const message = choice.message;
        const delta = part.delta ?? {};
        if (delta.role) message.role = delta.role;
        for (const key of ["content", "reasoning_content", "reasoning", "refusal"]) {
          if (typeof delta[key] === "string") message[key] = (message[key] ?? "") + delta[key];
        }
        if (delta.function_call) {
          message.function_call ??= { name: "", arguments: "" };
          appendFunction(message.function_call, delta.function_call);
        }
        for (const fragment of delta.tool_calls ?? []) {
          const toolIndex = index(fragment.index);
          const calls = tools.get(position);
          if (!calls.has(toolIndex))
            calls.set(toolIndex, { type: "function", function: { name: "", arguments: "" } });
          const call = calls.get(toolIndex);
          for (const key of ["id", "type"]) {
            if (fragment[key] !== undefined) call[key] = fragment[key];
          }
          if (fragment.function) appendFunction(call.function, fragment.function);
        }
        if (part.finish_reason != null) choice.finish_reason = part.finish_reason;
        if (part.logprobs) extra.logprobs = { ...extra.logprobs, ...part.logprobs };
      }
    },
    finish() {
      for (const [position, choice] of choices) {
        if (tools.get(position).size) choice.message.tool_calls = sorted(tools.get(position));
        Object.assign(choice, extraChoices.get(position));
        if (choice.message.content == null && !choice.message.tool_calls) {
          choice.message.content = "";
        }
      }
      body.choices = sorted(choices);
      if (!body.choices.length) throw new Error("Upstream stream carried no choices");
      return body;
    },
  };
}

function jsonError(source, message) {
  return new Response(
    JSON.stringify({ error: { type: "upstream_error", message } }),
    { status: 502, headers: headersFor(source) },
  );
}

// collapseResponse turns a chat SSE reply into a plain JSON chat.completion
// for a caller that did not ask to stream.
export async function collapseResponse(response) {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") return response;
  const accumulator = chatAccumulator();
  let completed = false;
  let failure;
  let eventName = "";
  let dataLines = [];
  let lineParts = [];
  let skipLF = false;

  function dispatch() {
    const name = eventName;
    const text = dataLines.join("\n");
    eventName = "";
    dataLines = [];
    if (failure) return;
    if (name === "error") {
      let value = text;
      try {
        value = JSON.parse(text);
      } catch {
        /* Error events may contain plain text. */
      }
      failure = errorMessage(value);
      return;
    }
    if (!text.trim()) return;
    if (text.trim() === "[DONE]") {
      completed = true;
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      failure = "Invalid JSON in upstream SSE event";
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      failure = "Invalid JSON object in upstream SSE event";
      return;
    }
    const type = data.type ?? name;
    if (data.error || type === "error") {
      failure = errorMessage(data.error ?? data);
      return;
    }
    try {
      accumulator.apply(data);
    } catch (error) {
      failure = errorMessage(error, "Invalid upstream SSE event");
    }
  }

  function line(value) {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") dataLines.push(content);
    if (field === "event") eventName = content;
  }

  function feed(text) {
    let start = 0;
    if (skipLF && text.length) {
      if (text[0] === "\n") start = 1;
      skipLF = false;
    }
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let match;
    while ((match = endings.exec(text))) {
      lineParts.push(text.slice(start, match.index));
      line(lineParts.join(""));
      lineParts = [];
      start = match.index + 1;
      if (match[0] === "\r") {
        if (text[start] === "\n") start++;
        else if (start === text.length) skipLF = true;
      }
      endings.lastIndex = start;
    }
    if (start < text.length) lineParts.push(text.slice(start));
  }

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          failure = "Upstream SSE exceeds the 32 MiB buffer limit";
          await reader.cancel();
          break;
        }
        feed(decoder.decode(value, { stream: true }));
        if (failure) {
          await reader.cancel();
          break;
        }
      }
      feed(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
  if (!failure && !completed) failure = "Upstream SSE ended without a completion marker";
  let body;
  if (!failure) {
    try {
      body = accumulator.finish();
    } catch (error) {
      failure = errorMessage(error);
    }
  }
  if (failure) return jsonError(response, failure);
  return new Response(JSON.stringify(body), { status: response.status, headers: headersFor(response) });
}

import { createServer } from "node:http";
import { once } from "node:events";
import { OpenCode2FreePlugin } from "./index.mjs";
import { PRESET_IDS } from "./models.mjs";

export const PUBLIC_AUTH = async () => ({ type: "api", key: "public" });

// A fake gateway: the model list, the catalog, and a chat endpoint that
// answers with whatever the test put in state.reply.
export async function fixture(t, input = {}, options = {}) {
  const state = { calls: [], reply: null, status: 200, contentType: "text/event-stream" };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    state.calls.push({ url: req.url, headers: req.headers, body });
    if (typeof state.onCall === "function") {
      state.onCall({ url: req.url, headers: req.headers, body });
    }
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

export function sse(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

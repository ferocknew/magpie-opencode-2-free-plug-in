import { createHash, randomBytes } from "node:crypto";
import {
  BASE_URL,
  CATALOG_URL,
  CLIENT_VERSION,
  MODELS_URL,
  PRESET_IDS,
  PROVIDER,
  SDK_CHAT,
  USER_AGENT,
  buildModels,
  configModels,
  isFreeId,
} from "./models.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardResponse, normalizeTools } from "./tool-response.mjs";

const CHAT_PATH = "/chat/completions";
const PUBLIC_KEY = "public";
// The host's session id reaches the loader through this private header,
// set by the chat.headers hook. It never leaves the plugin.
const SESSION_HEADER = "x-magpie-opencode2-session";
// A model the last list did not have waits this long before the list is
// asked again: a model made free since is served at once, and a model typed
// in by hand doesn't ask the list on every request.
const RELIST_AFTER = 60_000;

// opencodeID makes an id the way OpenCode 2 makes one: 12 lowercase hex
// characters of Date.now() * 0x1000 plus a per-millisecond counter, the
// counter bit-inverted for a descending id (a session, so newer sorts
// first), then 14 base62 characters. The free tier's gate checks a session
// id has this shape; a uuid or a hash is refused with 403 FreeTierError.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;

export function opencodeID(prefix, descending, now = Date.now()) {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter++;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

// realSessionID tells a session id OpenCode itself made from anything else:
// its low 12 bits hold the inverted per-millisecond counter, a small number.
export function realSessionID(value) {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "");
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16;
}

// One made-up session per conversation, so its turns keep one session.
const SESSIONS = new Map();
const KEEP_SESSIONS = 1000;

export function sessionID(headers, body) {
  let signal;
  for (const name of [
    SESSION_HEADER,
    "x-opencode-session",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    if (headers.get(name)) {
      signal = headers.get(name);
      break;
    }
  }
  if (!signal && typeof body.metadata?.session_id === "string") signal = body.metadata.session_id;
  if (realSessionID(signal)) return signal;
  if (!signal) {
    const messages = body.messages ?? body.input;
    const first = Array.isArray(messages)
      ? messages.find((message) => message.role === "user")?.content
      : messages;
    if (!first) return opencodeID("ses", true);
    signal = JSON.stringify(first);
  }
  const key = createHash("sha256").update(`ses\0${signal}`).digest("hex");
  let session = SESSIONS.get(key);
  if (session) {
    SESSIONS.delete(key);
  } else {
    session = opencodeID("ses", true);
    if (SESSIONS.size >= KEEP_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value);
  }
  SESSIONS.set(key, session);
  return session;
}

function httpURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

// Any key is accepted: the free tier is the public one, so a user who
// fills in their own key or leaves the field blank still works.
function publicKey(_auth) {
  return PUBLIC_KEY;
}

async function readJSON(url, headers, signal) {
  const timeout = AbortSignal.timeout(15000);
  const request = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { headers, signal: request });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model discovery returned HTTP ${response.status}`);
  }
  return response.json();
}

function catalogFreeModels(catalog) {
  const models = catalog?.opencode?.models;
  if (!models || typeof models !== "object") return {};
  const result = {};
  for (const [id, model] of Object.entries(models)) {
    if (!isFreeId(id, { [id]: model })) continue;
    result[id] = { ...model, provider: model.provider ?? {} };
  }
  return result;
}

function listingIDs(listing) {
  const data = listing?.data;
  if (!Array.isArray(data)) return null;
  return data.map((item) => item?.id).filter((id) => typeof id === "string" && id);
}

async function server(_input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? BASE_URL);
  const listURL = httpURL(options.modelsURL ?? MODELS_URL);
  const catalogURL = httpURL(options.catalogURL ?? CATALOG_URL);
  const chatURL = `${baseURL}${CHAT_PATH}`;
  let metadata = {};
  let listed = buildModels(PRESET_IDS, metadata, baseURL);
  let listedAt = 0;

  // discover asks the gateway's list and models.opencode.ai's catalog. The
  // list decides which free models are offered; the catalog describes them.
  async function discover(signal) {
    const headers = {
      authorization: `Bearer ${PUBLIC_KEY}`,
      "user-agent": USER_AGENT,
      "x-opencode-client": "cli",
    };
    const [list, catalog] = await Promise.allSettled([
      readJSON(listURL, headers, signal),
      readJSON(catalogURL, undefined, signal),
    ]);
    signal?.throwIfAborted();
    const fromCatalog =
      catalog.status === "fulfilled" ? catalogFreeModels(catalog.value) : null;
    if (fromCatalog) metadata = { ...metadata, ...fromCatalog };
    const ids = list.status === "fulfilled" ? listingIDs(list.value) : null;
    const offer = ids ? ids.filter((id) => isFreeId(id, metadata)) : PRESET_IDS;
    const models = buildModels(offer, metadata, baseURL);
    // A list read without the catalog still offers every free model it
    // names; a list unread keeps what was offered before, plus presets.
    for (const id of PRESET_IDS) {
      if (!models[id] && !ids) models[id] = buildModels([id], metadata, baseURL)[id];
    }
    if (Object.keys(models).length) {
      listed = models;
      listedAt = Date.now();
    }
    return listed;
  }

  async function ensureListed(signal) {
    if (!listedAt || Date.now() - listedAt >= RELIST_AFTER) {
      try {
        await discover(signal);
      } catch {
        /* Keep the last list; a request still names its model. */
      }
    }
    return listed;
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode 2 Free",
        npm: SDK_CHAT,
        api: baseURL,
        models: configModels(listed),
      };
    },

    auth: {
      provider: PROVIDER,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "OpenCode 2 免费访问（密钥填 public，或留空）",
          placeholder: PUBLIC_KEY,
          async authorize() {
            return { type: "success", key: PUBLIC_KEY };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        publicKey(auth);
        return {
          baseURL,
          apiKey: PUBLIC_KEY,
          async fetch(input, init) {
            const request = new Request(input, init);
            if (request.method !== "POST") {
              throw new Error("Unsupported OpenCode 2 Free endpoint or method");
            }
            const url = new URL(request.url);
            const base = new URL(baseURL);
            const sameEndpoint =
              url.origin === base.origin &&
              url.pathname.replace(/\/+$/, "") === new URL(chatURL).pathname.replace(/\/+$/, "");
            if (!sameEndpoint) throw new Error("Unsupported OpenCode 2 Free endpoint");
            request.signal.throwIfAborted();
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              throw new Error("Expected a JSON request object");
            }
            await ensureListed(request.signal);
            if (typeof body.model !== "string" || !body.model) {
              return new Response(
                JSON.stringify({
                  error: {
                    type: "invalid_request_error",
                    message: "A model is required.",
                  },
                }),
                { status: 400, headers: { "content-type": "application/json" } },
              );
            }
            if (!Object.hasOwn(listed, body.model)) {
              const free = Object.keys(listed).sort().join(", ");
              return new Response(
                JSON.stringify({
                  error: {
                    type: "not_found_error",
                    message: `Model ${body.model.slice(0, 128)} is not an OpenCode 2 free model now. Free models: ${free || "none"}.`,
                  },
                }),
                { status: 404, headers: { "content-type": "application/json" } },
              );
            }
            const streaming = body.stream === true;
            // The free tier refuses a non-streaming request and any request
            // without a `read` tool. Both are filled in here; a caller that
            // did not stream gets the reply collapsed back to JSON.
            body.stream = true;
            const toolPolicy = normalizeTools(body);
            body.stream_options = { ...body.stream_options, include_usage: true };

            const given = request.headers;
            const session = sessionID(given, body);
            const project = _input?.project;
            const headers = new Headers({
              "content-type": "application/json",
              accept: "*/*",
              "user-agent": USER_AGENT,
              authorization: `Bearer ${PUBLIC_KEY}`,
              "x-opencode-client": "cli",
              "x-opencode-project":
                given.get("x-opencode-project") ||
                (project?.vcs === "git" && project.id ? project.id : "global"),
              "x-opencode-session": session,
              "x-opencode-session-id": session,
              "x-session-affinity": session,
              "X-Session-Id": session,
              "x-opencode-request": opencodeID("msg", false),
            });

            const response = await fetch(chatURL, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
            const guarded = await guardResponse(response, toolPolicy, {
              endCutShort: streaming,
            });
            return streaming ? guarded : collapseResponse(guarded);
          },
        };
      },
      async usage() {
        return { plan: "OpenCode 2 Free", windows: [] };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider?.models ?? listed;
        try {
          const models = await discover();
          return Object.keys(models).length ? models : (provider?.models ?? listed);
        } catch {
          return provider?.models ?? listed;
        }
      },
    },

    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return;
      const session = String(input?.sessionID ?? "").trim();
      if (!session) return;
      output.headers[SESSION_HEADER] = session;
    },
  };
}

export const clientVersion = CLIENT_VERSION;

export default { id: PROVIDER, server };

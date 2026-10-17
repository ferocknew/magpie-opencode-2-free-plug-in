// Model metadata for the OpenCode 2 free tier. The gateway's own list
// (https://opencode.ai/inference/v1/models) names models but says nothing
// about them; models.opencode.ai's catalog describes them. This module knows
// the free models of OpenCode 2.0.31 offline, and merges whatever the live
// catalog and list add.

export const PROVIDER = "opencode-2-free";
export const SDK_CHAT = "@ai-sdk/openai-compatible";
export const BASE_URL = "https://opencode.ai/inference/openai/v1";
export const MODELS_URL = "https://opencode.ai/inference/v1/models";
export const CATALOG_URL = "https://models.opencode.ai/api.json";
export const CLIENT_VERSION = "2.0.31";
// The exact identity OpenCode 2.0.31 sends; the free tier's gate reads it.
export const USER_AGENT = `opencode/${CLIENT_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;

const reasoning = { field: "reasoning_content" };

// The free models OpenCode 2.0.31 offers, from the catalog on 2026-10-17.
// Every one of them streams reasoning_content and calls tools.
export const PRESET_MODELS = {
  "glm-5.3-flash-free": {
    name: "GLM-5.3-Flash Free",
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    attachment: true,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text", "image", "video", "pdf"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    temperature: true,
    release_date: "2026-08-26",
  },
  "deepseek-v4.1-flash-free": {
    name: "DeepSeek V4.1 Flash Free",
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    attachment: true,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    temperature: true,
    release_date: "2026-09-10",
  },
  "big-pickle": {
    name: "Big Pickle",
    limit: { context: 200000, input: 160000, output: 32000 },
    reasoning: true,
    attachment: false,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text"], output: ["text"] },
    reasoning_options: [],
    temperature: true,
    release_date: "2025-10-17",
  },
  "beam-free": {
    name: "Beam Free",
    limit: { context: 1048576, output: 131072 },
    reasoning: true,
    attachment: false,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    temperature: true,
    release_date: "2026-10-05",
  },
  "nemotron-3.5-super-vl-free": {
    name: "Nemotron 3.5 Super VL Free",
    limit: { context: 1048576, input: 1048576, output: 131072 },
    reasoning: true,
    attachment: true,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [
      { type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
    ],
    temperature: true,
    release_date: "2026-10-15",
  },
  "space-bunny-free": {
    name: "Space Bunny Free",
    limit: { context: 1048576, input: 524288, output: 524288 },
    reasoning: true,
    attachment: true,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    temperature: true,
    release_date: "2026-09-23",
  },
  "mimo-v2.6-flash-free": {
    name: "MiMo-V2.6-Flash Free",
    limit: { context: 200000, output: 32000 },
    reasoning: true,
    attachment: true,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    reasoning_options: [],
    temperature: true,
    release_date: "2026-09-22",
  },
  "nemotron-3.5-lightning-free": {
    name: "Nemotron 3.5 Lightning Free",
    limit: { context: 262144, output: 262144 },
    reasoning: true,
    attachment: false,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text"], output: ["text"] },
    reasoning_options: [],
    temperature: true,
    release_date: "2026-08-11",
  },
  "nemotron-3-ultra-free": {
    name: "Nemotron 3 Ultra Free",
    limit: { context: 1000000, output: 128000 },
    reasoning: true,
    attachment: false,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text"], output: ["text"] },
    reasoning_options: [],
    temperature: true,
    release_date: "2026-06-04",
  },
  "longcat-2.5-preview-free": {
    name: "LongCat 2.5 Preview Free",
    limit: { context: 1000000, output: 131072 },
    reasoning: true,
    attachment: true,
    tool_call: true,
    interleaved: reasoning,
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning_options: [],
    temperature: true,
    release_date: "2026-09-25",
  },
};

export const PRESET_IDS = Object.keys(PRESET_MODELS);

// Non-chat entries the gateway lists but that are not models to talk to:
// `test` is a probe, and jev is a SystemOne decision model.
export function isExcluded(id) {
  return id === "test" || id === "jev-1.13" || id.startsWith("jev-");
}

export function isRetired(model) {
  return (
    model?.deprecated === true ||
    ["deprecated", "retired", "disabled"].includes(model?.status ?? model?.lifecycle) ||
    model?.deprecated_at != null ||
    model?.retirement_date != null
  );
}

// A model is free when the catalog says it costs nothing, or its id says
// so and the catalog doesn't describe it yet.
export function isFreeId(id, metadata = {}) {
  if (typeof id !== "string" || !id || isExcluded(id)) return false;
  if (id === "__proto__") return false;
  const model = metadata[id];
  if (model && typeof model === "object") {
    if (isRetired(model)) return false;
    const cost = model.cost;
    if (cost && (Number(cost.input) > 0 || Number(cost.output) > 0)) return false;
    if (cost && Number(cost.input) === 0 && Number(cost.output) === 0) return true;
  }
  return /-free$/i.test(id) || id === "big-pickle";
}

function modalities(values) {
  return Object.fromEntries(
    ["text", "image", "audio", "video", "pdf"].map((name) => [name, values.includes(name)]),
  );
}

function effortsOf(model) {
  return (model.reasoning_options ?? [])
    .filter((option) => option?.type === "effort")
    .flatMap((option) => option.values ?? []);
}

// buildModels is the runtime model map OpenCode's provider.models hook
// answers: the catalog's metadata where it has it, the presets otherwise.
export function buildModels(ids, metadata = {}, baseURL = BASE_URL) {
  const result = {};
  for (const id of ids) {
    if (typeof id !== "string" || !id || id === "__proto__") continue;
    const model = metadata[id] ?? PRESET_MODELS[id] ?? {};
    const input = model.modalities?.input ?? ["text"];
    const output = model.modalities?.output ?? ["text"];
    const efforts = effortsOf(model);
    result[id] = {
      id,
      providerID: PROVIDER,
      name: model.name ?? id,
      api: { id, url: baseURL, npm: SDK_CHAT },
      limit: { context: 200000, output: 32000, ...model.limit },
      capabilities: {
        temperature: model.temperature ?? true,
        reasoning: model.reasoning ?? true,
        attachment: model.attachment ?? input.some((name) => name !== "text"),
        toolcall: model.tool_call ?? true,
        input: modalities(input),
        output: modalities(output),
        interleaved: model.interleaved ?? reasoning,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      variants: Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
      options: {},
      headers: {},
      status: model.status ?? "active",
      release_date: model.release_date ?? "",
      free: true,
    };
  }
  return result;
}

// configModels is what the config hook writes into OpenCode's provider
// config, the shape opencode.json's provider.models takes.
export function configModels(models) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        id,
        name: model.name,
        provider: { npm: model.api.npm, api: model.api.url },
        limit: model.limit,
        reasoning: model.capabilities.reasoning,
        tool_call: model.capabilities.toolcall,
        attachment: model.capabilities.attachment,
        modalities: {
          input: Object.keys(model.capabilities.input).filter(
            (key) => model.capabilities.input[key],
          ),
          output: Object.keys(model.capabilities.output).filter(
            (key) => model.capabilities.output[key],
          ),
        },
        cost: { input: 0, output: 0 },
        variants: model.variants,
        free: true,
      },
    ]),
  );
}

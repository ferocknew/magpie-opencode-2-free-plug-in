import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_IDS, buildModels, isFreeId } from "./models.mjs";

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

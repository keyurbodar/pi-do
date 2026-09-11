import assert from "node:assert/strict";
import test from "node:test";
import { resolveTurnModel } from "../src/model-runtime.ts";

const KEYED = { OPENCODE_API_KEY: "turn-model-probe", MODEL_ID: "opencode-go/muse-spark-1.3-contributor" };

test("null catalog keyless stays stub", () => {
  const r = resolveTurnModel({}, null);
  assert.equal(r.stub, true);
  assert.equal(r.model.id, "stub");
});

test("null catalog keyed resolves the server default", () => {
  const r = resolveTurnModel(KEYED, null);
  assert.equal(r.stub, false);
  assert.equal(r.provider, "opencode-go");
  assert.equal(r.model.id, "muse-spark-1.3-contributor");
});

test("null catalog keyed without override takes the first default", () => {
  const r = resolveTurnModel({ OPENCODE_API_KEY: "turn-model-probe" }, null);
  assert.equal(r.stub, false);
});

test("null catalog with a bad override throws unknown model", () => {
  try {
    resolveTurnModel({ OPENCODE_API_KEY: "turn-model-probe", MODEL_ID: "nope/nope" }, null);
  } catch (e) {
    assert.match(e.error, /unknown model/);
    return;
  }
  assert.fail("bad override must throw");
});

test("pinned catalog keyless records the pin and stays stub", () => {
  const pin = { id: "muse-spark-1.3-contributor", provider: "opencode-go" };
  const r = resolveTurnModel({}, pin);
  assert.equal(r.stub, true);
  assert.equal(r.like, pin);
});

// Pattern source (read-only): refs/pi/packages/ai src/types.ts Model
// (id/name/api/provider/baseUrl plus a stream function) and
// refs/pi/packages/coding-agent ModelRuntime.create (async model/auth
// facade). Here the runtime is sync and key-driven: provider keys are read
// from env, otherwise the deterministic stub stands in. Never log keys:
// key material only decides the branch and never leaves memory.
// Catalog source: pi-ai owns model ids, urls, and prices. This file only
// looks models up in the installed data slices (never the provider runtime
// or auth modules) and fails closed on unknown or ambiguous ids.
// Custom endpoints come from worker/models.json (bundled via import, never
// fs), merged over built-ins by provider id. models.json carries zero
// secret material: an inline apiKey is rejected, keys arrive only as Worker
// secrets under <PROVIDER_ID>_API_KEY (uppercased, non-alphanumerics to _).
import { ANT_LING_MODELS } from "@earendil-works/pi-ai/providers/ant-ling.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { AZURE_OPENAI_RESPONSES_MODELS } from "@earendil-works/pi-ai/providers/azure-openai-responses.models";
import { BASETEN_MODELS } from "@earendil-works/pi-ai/providers/baseten.models";
import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { MINIMAX_CN_MODELS } from "@earendil-works/pi-ai/providers/minimax-cn.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { NVIDIA_MODELS } from "@earendil-works/pi-ai/providers/nvidia.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENCODE_MODELS } from "@earendil-works/pi-ai/providers/opencode.models";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { QWEN_TOKEN_PLAN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan.models";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import { QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual.models";
import { TOGETHER_MODELS } from "@earendil-works/pi-ai/providers/together.models";
import { VERCEL_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { XIAOMI_MODELS } from "@earendil-works/pi-ai/providers/xiaomi.models";
import { XIAOMI_TOKEN_PLAN_AMS_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams.models";
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models";
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { ZAI_CODING_CN_MODELS } from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import type { Api, Model } from "@earendil-works/pi-ai";
import bundledModelsJson from "../models.json" with { type: "json" };
export const STUB_MODEL_ID = "stub";

export interface RuntimeModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  contextWindow: Model<Api>["contextWindow"];
  maxTokens: Model<Api>["maxTokens"];
  cost: Model<Api>["cost"];
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface ModelRuntime {
  model: RuntimeModel;
  stub: boolean;
}

// pi thinking universe, mirroring pi-ai EXTENDED_THINKING_LEVELS
// (refs/pi packages/ai src/models.ts): every level a caller may name.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface ThinkingModelLike {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

// Same semantics as pi-ai getSupportedThinkingLevels: non-reasoning models
// support only off; xhigh/max need an explicit map entry, null maps exclude.
export function supportedThinkingLevels(model: ThinkingModelLike): string[] {
  if (!model.reasoning) return ["off"];
  return (THINKING_LEVELS as readonly string[]).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

// Same semantics as pi-ai clampThinkingLevel: known levels settle on the
// nearest supported one (up first, then down); unknown input falls to off.
export function clampThinkingLevel(model: ThinkingModelLike, level: string): string {
  const available = supportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requestedIndex = (THINKING_LEVELS as readonly string[]).indexOf(level);
  if (requestedIndex === -1) return available[0] ?? "off";
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i];
    if (available.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i];
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

export interface RuntimeEnv {
  ANT_LING_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AZURE_OPENAI_API_KEY?: string;
  BASETEN_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  FIREWORKS_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
  KIMI_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_CN_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  QWEN_TOKEN_PLAN_API_KEY?: string;
  QWEN_TOKEN_PLAN_CN_API_KEY?: string;
  TOGETHER_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  XAI_API_KEY?: string;
  XIAOMI_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_AMS_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_CN_API_KEY?: string;
  XIAOMI_TOKEN_PLAN_SGP_API_KEY?: string;
  ZAI_API_KEY?: string;
  ZAI_CODING_CN_API_KEY?: string;
  MODEL_ID?: string;
  [customKey: string]: string | undefined;
}

interface BuiltinEntry {
  envVar: string;
  catalog: Record<string, Model<Api>>;
}

// Precedence on multiple keys is table order: anthropic, openai (legacy
// default order), then remaining built-ins alphabetical by provider id,
// then custom models.json providers alphabetical by id.
const BUILTINS: BuiltinEntry[] = [
  { envVar: "ANTHROPIC_API_KEY", catalog: ANTHROPIC_MODELS },
  { envVar: "OPENAI_API_KEY", catalog: OPENAI_MODELS },
  { envVar: "ANT_LING_API_KEY", catalog: ANT_LING_MODELS },
  {
    envVar: "AZURE_OPENAI_API_KEY",
    catalog: AZURE_OPENAI_RESPONSES_MODELS,
  },
  { envVar: "BASETEN_API_KEY", catalog: BASETEN_MODELS },
  { envVar: "CEREBRAS_API_KEY", catalog: CEREBRAS_MODELS },
  { envVar: "DEEPSEEK_API_KEY", catalog: DEEPSEEK_MODELS },
  { envVar: "FIREWORKS_API_KEY", catalog: FIREWORKS_MODELS },
  { envVar: "GEMINI_API_KEY", catalog: GOOGLE_MODELS },
  { envVar: "GROQ_API_KEY", catalog: GROQ_MODELS },
  { envVar: "HF_TOKEN", catalog: HUGGINGFACE_MODELS },
  { envVar: "KIMI_API_KEY", catalog: KIMI_CODING_MODELS },
  { envVar: "MINIMAX_API_KEY", catalog: MINIMAX_MODELS },
  { envVar: "MINIMAX_CN_API_KEY", catalog: MINIMAX_CN_MODELS },
  { envVar: "MISTRAL_API_KEY", catalog: MISTRAL_MODELS },
  { envVar: "MOONSHOT_API_KEY", catalog: MOONSHOTAI_MODELS },
  { envVar: "MOONSHOT_API_KEY", catalog: MOONSHOTAI_CN_MODELS },
  { envVar: "NVIDIA_API_KEY", catalog: NVIDIA_MODELS },
  { envVar: "OPENCODE_API_KEY", catalog: OPENCODE_MODELS },
  { envVar: "OPENCODE_API_KEY", catalog: OPENCODE_GO_MODELS },
  { envVar: "OPENROUTER_API_KEY", catalog: OPENROUTER_MODELS },
  { envVar: "QWEN_TOKEN_PLAN_API_KEY", catalog: QWEN_TOKEN_PLAN_MODELS },
  {
    envVar: "QWEN_TOKEN_PLAN_CN_API_KEY",
    catalog: QWEN_TOKEN_PLAN_CN_MODELS,
  },
  {
    envVar: "QWEN_TOKEN_PLAN_API_KEY",
    catalog: QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS,
  },
  { envVar: "TOGETHER_API_KEY", catalog: TOGETHER_MODELS },
  { envVar: "AI_GATEWAY_API_KEY", catalog: VERCEL_AI_GATEWAY_MODELS },
  { envVar: "XAI_API_KEY", catalog: XAI_MODELS },
  { envVar: "XIAOMI_API_KEY", catalog: XIAOMI_MODELS },
  {
    envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    catalog: XIAOMI_TOKEN_PLAN_AMS_MODELS,
  },
  {
    envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    catalog: XIAOMI_TOKEN_PLAN_CN_MODELS,
  },
  {
    envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    catalog: XIAOMI_TOKEN_PLAN_SGP_MODELS,
  },
  { envVar: "ZAI_API_KEY", catalog: ZAI_MODELS },
  { envVar: "ZAI_CODING_CN_API_KEY", catalog: ZAI_CODING_CN_MODELS },
];

// models.json glue, written field for field against pi's ModelsJson provider
// schema (refs/pi packages/coding-agent src/core/model-config.ts
// ProviderConfigSchema): name, baseUrl, apiKey, api, oauth, headers, compat,
// authHeader, models, modelOverrides. Resolution honors api, baseUrl,
// models, and modelOverrides; name is display-only; headers/compat/
// authHeader/samplingParams shape request assembly, which this runtime never
// does, so they are accepted and ignored. apiKey and oauth are rejected:
// keys arrive only as Worker secrets, and there are no OAuth code paths.
export interface ModelsJsonCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelsJsonModelDef {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  cost?: ModelsJsonCost;
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: unknown;
}

export interface ModelsJsonModelOverride {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  cost?: ModelsJsonCost;
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: unknown;
}

export interface ModelsJsonProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  oauth?: string;
  headers?: Record<string, string>;
  compat?: unknown;
  authHeader?: boolean;
  models?: ModelsJsonModelDef[];
  modelOverrides?: Record<string, ModelsJsonModelOverride>;
}

export interface ModelsJsonDoc {
  providers?: Record<string, ModelsJsonProviderConfig>;
}

interface CustomProvider {
  id: string;
  api: string;
  baseUrl?: string;
  models: ModelsJsonModelDef[];
  overrides: Record<string, ModelsJsonModelOverride>;
}

function fail(error: string, hint: string): never {
  throw { error, hint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  owner: string,
  field: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    fail(
      `invalid models.json ${owner}: ${field}`,
      `set ${field} to a non-empty string in worker/models.json`,
    );
  return value;
}

function optionalNumber(
  owner: string,
  field: string,
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(
      `invalid models.json ${owner}: ${field}`,
      `set ${field} to a finite number >= 0 in worker/models.json`,
    );
  return value;
}

function requiredCost(
  owner: string,
  value: ModelsJsonCost | undefined,
  base: RuntimeModel["cost"] | undefined,
): RuntimeModel["cost"] {
  const merged = {
    input: value?.input ?? base?.input,
    output: value?.output ?? base?.output,
    cacheRead: value?.cacheRead ?? base?.cacheRead,
    cacheWrite: value?.cacheWrite ?? base?.cacheWrite,
  };
  for (const [field, rate] of Object.entries(merged)) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
      fail(
        `invalid models.json ${owner}: cost.${field}`,
        `set cost.${field} to a finite number >= 0 in worker/models.json`,
      );
  }
  return merged as RuntimeModel["cost"];
}

export function customKeyEnvVar(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
// Inference-time key for one provider id: the built-in env var when the id
// names a built-in, else the <PROVIDER_ID>_API_KEY Worker secret. Key
// material only decides this branch; callers pass it into pi-ai options and
// never log it.
export function resolveProviderKey(env: RuntimeEnv, providerId: string): string | undefined {
  const builtin = BUILTINS.find((entry) => providerIdOf(entry.catalog) === providerId);
  const names = builtin !== undefined ? [builtin.envVar, customKeyEnvVar(providerId)] : [customKeyEnvVar(providerId)];
  for (const name of names) {
    const key = env[name];
    if (typeof key === "string" && key.length > 0) return key;
  }
  return undefined;
}

export function loadCustomProviders(doc: unknown): Map<string, CustomProvider> {
  const out = new Map<string, CustomProvider>();
  if (doc === undefined || doc === null) return out;
  if (!isRecord(doc) || (doc.providers !== undefined && !isRecord(doc.providers)))
    fail(
      "invalid models.json: providers",
      "shape worker/models.json as { providers: { <id>: { api, baseUrl, models, modelOverrides } } }",
    );
  const providers = (doc as ModelsJsonDoc).providers ?? {};
  for (const [id, raw] of Object.entries(providers)) {
    if (id.length === 0 || id.includes("/"))
      fail(
        `invalid models.json provider id: ${id}`,
        "name the provider without / so MODEL_ID stays provider/id",
      );
    if (!isRecord(raw))
      fail(
        `invalid models.json provider: ${id}`,
        "shape the provider as { api, baseUrl, models, modelOverrides }",
      );
    const provider = raw as ModelsJsonProviderConfig;
    if (provider.apiKey !== undefined)
      fail(
        `models.json provider "${id}" sets inline apiKey`,
        `remove apiKey from worker/models.json; set ${customKeyEnvVar(id)} as a Worker secret instead (env-only rule: the file carries zero secret material)`,
      );
    if (provider.oauth !== undefined)
      fail(
        `models.json provider "${id}" uses oauth`,
        "oauth is unsupported here; point the provider at an OpenAI-compatible endpoint with a Worker secret key instead",
      );
    const api =
      optionalString(`provider "${id}"`, "api", provider.api) ??
      "openai-completions";
    const baseUrl = optionalString(`provider "${id}"`, "baseUrl", provider.baseUrl);
    if (provider.models !== undefined && !Array.isArray(provider.models))
      fail(
        `invalid models.json provider "${id}": models`,
        "set models to an array of { id, baseUrl, contextWindow, maxTokens, cost } in worker/models.json",
      );
    const models = (provider.models ?? []).map((def, index) => {
      const owner = `provider "${id}" model #${index + 1}`;
      if (!isRecord(def) || typeof def.id !== "string" || def.id.length === 0)
        fail(
          `invalid models.json ${owner}: id`,
          "give every custom model a non-empty string id in worker/models.json",
        );
      return def as ModelsJsonModelDef;
    });
    if (provider.modelOverrides !== undefined && !isRecord(provider.modelOverrides))
      fail(
        `invalid models.json provider "${id}": modelOverrides`,
        "set modelOverrides to a { <model id>: { contextWindow, maxTokens, cost } } map in worker/models.json",
      );
    out.set(id, {
      id,
      api,
      baseUrl,
      models,
      overrides: provider.modelOverrides ?? {},
    });
  }
  return out;
}

function toRuntime(provider: string, entry: Model<Api>): RuntimeModel {
  return {
    id: entry.id,
    name: entry.name,
    api: entry.api,
    provider: entry.provider || provider,
    baseUrl: entry.baseUrl,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: entry.cost,
    reasoning: entry.reasoning,
    thinkingLevelMap: entry.thinkingLevelMap,
  };
}

function providerIdOf(catalog: Record<string, Model<Api>>): string {
  const first = Object.values(catalog)[0];
  if (!first)
    fail("empty built-in catalog", "report this as a pi-ai packaging bug");
  return first.provider;
}

function mergedCatalog(
  providerId: string,
  base: Map<string, RuntimeModel>,
  custom: CustomProvider | undefined,
): Map<string, RuntimeModel> {
  const out = new Map(base);
  if (!custom) return out;
  if (custom.baseUrl !== undefined)
    for (const [id, entry] of out)
      out.set(id, { ...entry, baseUrl: custom.baseUrl });
  for (const def of custom.models) {
    const baseEntry = out.get(def.id);
    const owner = `provider "${providerId}" model "${def.id}"`;
    const baseUrl = def.baseUrl ?? custom.baseUrl ?? baseEntry?.baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.length === 0)
      fail(
        `invalid models.json ${owner}: baseUrl`,
        `set baseUrl on the model or the provider "${providerId}" in worker/models.json`,
      );
    const contextWindow =
      optionalNumber(owner, "contextWindow", def.contextWindow) ??
      baseEntry?.contextWindow;
    const maxTokens =
      optionalNumber(owner, "maxTokens", def.maxTokens) ?? baseEntry?.maxTokens;
    if (contextWindow === undefined || maxTokens === undefined)
      fail(
        `invalid models.json ${owner}: contextWindow/maxTokens`,
        `new custom models need numeric contextWindow and maxTokens in worker/models.json (overrides of built-in models inherit them)`,
      );
    out.set(def.id, {
      id: def.id,
      name: def.name ?? baseEntry?.name ?? def.id,
      api: def.api ?? baseEntry?.api ?? custom.api,
      provider: providerId,
      baseUrl: baseUrl as string,
      contextWindow,
      maxTokens,
      cost: requiredCost(owner, def.cost, baseEntry?.cost),
      reasoning: def.reasoning ?? baseEntry?.reasoning ?? false,
      thinkingLevelMap: def.thinkingLevelMap ?? baseEntry?.thinkingLevelMap,
    });
  }
  for (const [modelId, override] of Object.entries(custom.overrides)) {
    const entry = out.get(modelId);
    if (!entry)
      fail(
        `unknown models.json provider "${providerId}" override: ${modelId}`,
        `available ${providerId} models: ${[...out.keys()].sort().join(", ")}`,
      );
    const owner = `provider "${providerId}" override "${modelId}"`;
    out.set(modelId, {
      ...entry,
      name: override.name ?? entry.name,
      contextWindow:
        optionalNumber(owner, "contextWindow", override.contextWindow) ??
        entry.contextWindow,
      maxTokens:
        optionalNumber(owner, "maxTokens", override.maxTokens) ??
        entry.maxTokens,
      cost: requiredCost(owner, override.cost, entry.cost),
      reasoning: override.reasoning ?? entry.reasoning ?? false,
      thinkingLevelMap: override.thinkingLevelMap ?? entry.thinkingLevelMap,
    });
  }
  return out;
}

interface KeyedProvider {
  id: string;
  catalog: Map<string, RuntimeModel>;
}

function hasKey(env: RuntimeEnv, name: string): boolean {
  return typeof env[name] === "string" && (env[name] as string).length > 0;
}

function availableList(keyed: KeyedProvider[]): string {
  const ids: string[] = [];
  for (const provider of keyed)
    for (const modelId of provider.catalog.keys())
      ids.push(`${provider.id}/${modelId}`);
  return ids.sort().join(", ");
}

function stubRuntime(): ModelRuntime {
  // DEV-ONLY fallback: no provider keys in env, so the keyless stub stands
  // in. Production callers must supply keys; this branch exists for local
  // verify without credentials.
  return {
    model: {
      id: STUB_MODEL_ID,
      name: STUB_MODEL_ID,
      api: "stub",
      provider: "stub",
      baseUrl: "",
      contextWindow: 0,
      maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stub: true,
  };
}

// Full merged catalog (built-ins plus models.json customs), independent of
// keys: session switches validate against this so fail-closed naming works
// keyless, while inference still needs a keyed provider below.
export function buildAllProviders(customDoc: unknown = bundledModelsJson): KeyedProvider[] {
  const customs = loadCustomProviders(customDoc);
  const seen = new Set<string>();
  const providers: KeyedProvider[] = [];
  for (const builtin of BUILTINS) {
    const id = providerIdOf(builtin.catalog);
    let provider = providers.find((candidate) => candidate.id === id);
    if (!provider) {
      provider = { id, catalog: new Map<string, RuntimeModel>() };
      providers.push(provider);
      seen.add(id);
    }
    for (const entry of Object.values(builtin.catalog)) {
      const runtime = toRuntime(id, entry);
      if (!provider.catalog.has(runtime.id))
        provider.catalog.set(runtime.id, runtime);
    }
  }
  for (const provider of providers)
    provider.catalog = mergedCatalog(provider.id, provider.catalog, customs.get(provider.id));
  for (const id of [...customs.keys()].sort()) {
    if (seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      catalog: mergedCatalog(id, new Map(), customs.get(id)),
    });
  }
  return providers;
}

export function providerIdList(providers: KeyedProvider[]): string {
  return providers.map((provider) => provider.id).sort().join(", ");
}

// Session/model lookup against the full catalog: unknown provider names the
// provider id list, unknown id names that provider's models. Throws
// {error, hint} like the buildRuntime paths below.
export function resolveCatalogModel(
  providerId: string,
  modelId: string,
  customDoc: unknown = bundledModelsJson,
): RuntimeModel {
  const providers = buildAllProviders(customDoc);
  const scoped = providers.find((provider) => provider.id === providerId);
  if (!scoped)
    fail(
      `unknown provider: ${providerId}`,
      `available providers: ${providerIdList(providers)}`,
    );
  const entry = (scoped as KeyedProvider).catalog.get(modelId);
  if (!entry)
    fail(
      `unknown model: ${providerId}/${modelId}`,
      `available ${providerId} models: ${[...(scoped as KeyedProvider).catalog.keys()].sort().join(", ")}`,
    );
  return entry as RuntimeModel;
}

export interface CatalogLine {
  provider: string;
  id: string;
  name: string;
  contextWindow: RuntimeModel["contextWindow"];
  maxTokens: RuntimeModel["maxTokens"];
}

export function listCatalogModels(customDoc: unknown = bundledModelsJson): CatalogLine[] {
  const out: CatalogLine[] = [];
  for (const provider of buildAllProviders(customDoc))
    for (const entry of provider.catalog.values())
      out.push({
        provider: provider.id,
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
      });
  out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  return out;
}

// Providers with keys in env, in buildRuntime precedence order. Empty means
// the keyless stub stands in and inference records the session triple.
export function keyedProviders(
  env: RuntimeEnv,
  customDoc: unknown = bundledModelsJson,
): KeyedProvider[] {
  return buildAllProviders(customDoc).filter(
    (provider) =>
      BUILTINS.some(
        (builtin) =>
          providerIdOf(builtin.catalog) === provider.id &&
          hasKey(env, builtin.envVar),
      ) || hasKey(env, customKeyEnvVar(provider.id)),
  );
}

// Inference-time lookup: same unknown-id fail-closed shapes as buildRuntime,
// scoped to the keyed providers.
export function resolveKeyedModel(
  env: RuntimeEnv,
  providerId: string,
  modelId: string,
  customDoc: unknown = bundledModelsJson,
): RuntimeModel {
  const keyed = keyedProviders(env, customDoc);
  const scoped = keyed.find((provider) => provider.id === providerId);
  if (!scoped)
    fail(
      `unknown provider: ${providerId}`,
      `providers with keys: ${providerIdList(keyed)}`,
    );
  const entry = scoped.catalog.get(modelId);
  if (!entry)
    fail(
      `unknown model: ${providerId}/${modelId}`,
      `available ${providerId} models: ${[...scoped.catalog.keys()].sort().join(", ")}`,
    );
  return entry;
}
export const LIVE_MODELS_TTL_MS = 10 * 60 * 1000;

const liveModelsCache = new Map<string, { ids: Set<string>; expiresAt: number }>();

export function clearLiveModelsCache(): void {
  liveModelsCache.clear();
}

export async function resolveKeyedModelLive(
  env: RuntimeEnv,
  providerId: string,
  modelId: string,
  customDoc?: unknown,
  fetchImpl?: typeof fetch,
): Promise<RuntimeModel> {
  const doc = customDoc ?? bundledModelsJson;
  const keyed = keyedProviders(env, doc);
  const scoped = keyed.find((provider) => provider.id === providerId);
  if (!scoped)
    fail(
      `unknown provider: ${providerId}`,
      `providers with keys: ${providerIdList(keyed)}`,
    );
  const pinned = scoped.catalog.get(modelId);
  const key = resolveProviderKey(env, providerId);
  const baseUrl =
    pinned?.baseUrl ??
    [...scoped.catalog.values()][0]?.baseUrl ??
    loadCustomProviders(doc).get(providerId)?.baseUrl ??
    "";
  if (key === undefined || providerId === "stub" || baseUrl.length === 0)
    return resolveKeyedModel(env, providerId, modelId, doc);
  const cached = liveModelsCache.get(baseUrl);
  let ids = cached && cached.expiresAt > Date.now() ? cached.ids : undefined;
  if (!ids) {
    let live: Set<string> | undefined;
    try {
      const response = await (fetchImpl ?? globalThis.fetch)(
        `${baseUrl.replace(/\/+$/, "")}/models`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) {
        const body: unknown = await response.json();
        if (isRecord(body) && Array.isArray(body.data)) {
          const found = new Set<string>();
          for (const item of body.data)
            if (isRecord(item) && typeof item.id === "string") found.add(item.id);
          live = found;
        }
      }
    } catch {
      live = undefined;
    }
    if (!live || live.size === 0) {
      liveModelsCache.delete(baseUrl);
      return resolveKeyedModel(env, providerId, modelId, doc);
    }
    liveModelsCache.set(baseUrl, { ids: live, expiresAt: Date.now() + LIVE_MODELS_TTL_MS });
    ids = live;
  }
  if (!ids.has(modelId))
    fail(
      `stale model: ${providerId}/${modelId}`,
      `pinned model ${providerId}/${modelId} is missing from the live ${providerId} list; refresh the pin in worker/models.json`,
    );
  const entry = scoped.catalog.get(modelId);
  if (!entry)
    fail(
      `unpinned model: ${providerId}/${modelId}`,
      `available-but-unpinned: ${providerId}/${modelId}; add routing specs (api, baseUrl, contextWindow, maxTokens, cost) for ${providerId}/${modelId} in worker/models.json; specs are never guessed`,
    );
  return entry;
}

export function buildRuntime(
  env: RuntimeEnv,
  customDoc: unknown = bundledModelsJson,
): ModelRuntime {
  const keyed = keyedProviders(env, customDoc);
  if (keyed.length === 0) return stubRuntime();

  const override =
    typeof env.MODEL_ID === "string" && env.MODEL_ID.length > 0
      ? env.MODEL_ID
      : undefined;
  if (override !== undefined) {
    const exact = keyed.filter((provider) => provider.catalog.has(override));
    if (exact.length === 1)
      return {
        model: exact[0].catalog.get(override) as RuntimeModel,
        stub: false,
      };
    if (exact.length > 1)
      fail(
        `ambiguous model id: ${override}`,
        `it matches providers ${exact.map((provider) => provider.id).sort().join(", ")}; retry as provider/id`,
      );
    const slash = override.indexOf("/");
    if (slash > 0) {
      const scoped = keyed.find(
        (provider) => provider.id === override.slice(0, slash),
      );
      if (scoped) {
        const want = override.slice(slash + 1);
        const entry = scoped.catalog.get(want);
        if (!entry)
          fail(
            `unknown model: ${override}`,
            `available ${scoped.id} models: ${[...scoped.catalog.keys()].sort().join(", ")}`,
          );
        return { model: entry, stub: false };
      }
    }
    fail(
      `unknown model: ${override}`,
      `available models: ${availableList(keyed)}`,
    );
  }
  const first = keyed[0];
  const defaultId = [...first.catalog.keys()].sort()[0];
  if (defaultId === undefined)
    fail(
      `provider has no models: ${first.id}`,
      `add models to provider "${first.id}" in worker/models.json or pick another MODEL_ID`,
    );
  return { model: first.catalog.get(defaultId) as RuntimeModel, stub: false };
}

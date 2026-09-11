import {
  clampThinkingLevel as piClampThinkingLevel,
  createModels,
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels as piSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type { Api, AuthContext, Model, ModelThinkingLevel, MutableModels, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { getApiProvider, getEnvApiKey, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import bundledModelsJson from "../models.json" with { type: "json" };

export const STUB_MODEL_ID = "stub";

export interface RuntimeModel {
  id: string; name: string; api: string; provider: string; baseUrl: string;
  contextWindow: Model<Api>["contextWindow"]; maxTokens: Model<Api>["maxTokens"]; cost: Model<Api>["cost"];
  reasoning?: boolean; thinkingLevelMap?: Record<string, string | null>; headers?: Record<string, string>;
}

export interface ModelRuntime { model: RuntimeModel; stub: boolean; }

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

interface ThinkingLike { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>>; }
export function supportedThinkingLevels(model: ThinkingLike): string[] {
  return piSupportedThinkingLevels(model as Model<Api>);
}

export function clampThinkingLevel(model: ThinkingLike, level: string): string {
  return piClampThinkingLevel(model as Model<Api>, level as ModelThinkingLevel);
}

export interface RuntimeEnv { MODEL_ID?: string; [key: string]: string | undefined; }

export type ModelsJsonCost = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
export interface ModelsJsonModelDef { id: string; name?: string; api?: string; baseUrl?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null>; cost?: ModelsJsonCost; contextWindow?: number; maxTokens?: number; headers?: Record<string, string>; }
export interface ModelsJsonModelOverride { name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null>; cost?: ModelsJsonCost; contextWindow?: number; maxTokens?: number; headers?: Record<string, string>; }
export interface ModelsJsonProviderConfig { name?: string; baseUrl?: string; apiKey?: string; api?: string; oauth?: string; headers?: Record<string, string>; models?: ModelsJsonModelDef[]; modelOverrides?: Record<string, ModelsJsonModelOverride>; }
export interface ModelsJsonDoc { providers?: Record<string, ModelsJsonProviderConfig>; }

interface ProviderEntry { id: string; name?: string; api: string; baseUrl?: string; headers?: Record<string, string>; models: ModelsJsonModelDef[]; overrides: Record<string, ModelsJsonModelOverride>; }

function fail(error: string, hint: string): never {
  throw { error, hint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const out = Object.assign({}, ...sources);
  return Object.keys(out).length > 0 ? out : undefined;
}

function checkString(owner: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) fail(`invalid models.json ${owner}: ${field}`, `set ${field} to a non-empty string in worker/models.json`);
  return value;
}

function checkNumber(owner: string, field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`invalid models.json ${owner}: ${field}`, `set ${field} to a finite number >= 0 in worker/models.json`);
  return value;
}

function checkHeaders(owner: string, field: string, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(`invalid models.json ${owner}: ${field}`, `set ${field} to a { <name>: <value> } string map in worker/models.json`);
  const out: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (name.length === 0 || typeof header !== "string" || header.length === 0) fail(`invalid models.json ${owner}: ${field}`, `set ${field} to a { <name>: <value> } string map with non-empty names and values in worker/models.json`);
    out[name] = header;
  }
  return out;
}

function checkCost(owner: string, value: ModelsJsonCost | undefined, base: RuntimeModel["cost"] | undefined): RuntimeModel["cost"] {
  const merged = { input: value?.input ?? base?.input, output: value?.output ?? base?.output, cacheRead: value?.cacheRead ?? base?.cacheRead, cacheWrite: value?.cacheWrite ?? base?.cacheWrite };
  for (const [field, rate] of Object.entries(merged)) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) fail(`invalid models.json ${owner}: cost.${field}`, `set cost.${field} to a finite number >= 0 in worker/models.json`);
  }
  return merged as RuntimeModel["cost"];
}

export function customKeyEnvVar(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function maskProcess<T>(run: () => T): T {
  const scope = globalThis as { process?: unknown };
  const saved = scope.process;
  scope.process = undefined;
  try {
    return run();
  } finally {
    scope.process = saved;
  }
}

function usableKey(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 || value === "<authenticated>" ? undefined : value;
}

export function resolveProviderKey(env: RuntimeEnv, providerId: string): string | undefined {
  return usableKey(maskProcess(() => getEnvApiKey(providerId, env as Record<string, string>))) ?? usableKey(env[customKeyEnvVar(providerId)]);
}

export function loadCustomProviders(doc: unknown): Map<string, ProviderEntry> {
  const out = new Map<string, ProviderEntry>();
  if (doc === undefined || doc === null) return out;
  if (!isRecord(doc) || (doc.providers !== undefined && !isRecord(doc.providers))) fail("invalid models.json: providers", "shape worker/models.json as { providers: { <id>: { api, baseUrl, models, modelOverrides } } }");
  const providers = (doc as ModelsJsonDoc).providers ?? {};
  for (const [id, raw] of Object.entries(providers)) {
    if (id.length === 0 || id.includes("/")) fail(`invalid models.json provider id: ${id}`, "name the provider without / so MODEL_ID stays provider/id");
    if (!isRecord(raw)) fail(`invalid models.json provider: ${id}`, "shape the provider as { api, baseUrl, models, modelOverrides }");
    const provider = raw as ModelsJsonProviderConfig;
    if (provider.apiKey !== undefined) fail(`models.json provider "${id}" sets inline apiKey`, `remove apiKey from worker/models.json; set ${customKeyEnvVar(id)} as a Worker secret instead (env-only rule: the file carries zero secret material)`);
    if (provider.oauth !== undefined) fail(`models.json provider "${id}" uses oauth`, "oauth is unsupported here; point the provider at an OpenAI-compatible endpoint with a Worker secret key instead");
    if (provider.models !== undefined && !Array.isArray(provider.models)) fail(`invalid models.json provider "${id}": models`, "set models to an array of { id, baseUrl, contextWindow, maxTokens, cost } in worker/models.json");
    const models = (provider.models ?? []).map((def, index) => {
      const owner = `provider "${id}" model #${index + 1}`;
      if (!isRecord(def) || typeof def.id !== "string" || def.id.length === 0) fail(`invalid models.json ${owner}: id`, "give every custom model a non-empty string id in worker/models.json");
      return def as ModelsJsonModelDef;
    });
    if (provider.modelOverrides !== undefined && !isRecord(provider.modelOverrides)) fail(`invalid models.json provider "${id}": modelOverrides`, "set modelOverrides to a { <model id>: { contextWindow, maxTokens, cost } } map in worker/models.json");
    out.set(id, { id, name: provider.name, api: checkString(`provider "${id}"`, "api", provider.api) ?? "openai-completions", baseUrl: checkString(`provider "${id}"`, "baseUrl", provider.baseUrl), headers: checkHeaders(`provider "${id}"`, "headers", provider.headers), models, overrides: provider.modelOverrides ?? {} });
  }
  return out;
}

function toRuntime(provider: string, entry: Model<Api>): RuntimeModel {
  return { id: entry.id, name: entry.name, api: entry.api, provider: entry.provider || provider, baseUrl: entry.baseUrl, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, cost: entry.cost, reasoning: entry.reasoning, thinkingLevelMap: entry.thinkingLevelMap, headers: entry.headers };
}

function applyEntry(base: readonly Model<Api>[], entry: ProviderEntry): Array<Model<Api>> {
  const out = new Map<string, Model<Api>>();
  for (const model of base) {
    if (!out.has(model.id)) out.set(model.id, { ...model, baseUrl: entry.baseUrl ?? model.baseUrl, headers: mergeHeaders(model.headers, entry.headers) });
  }
  for (const def of entry.models) {
    const prior = out.get(def.id);
    const owner = `provider "${entry.id}" model "${def.id}"`;
    const baseUrl = def.baseUrl ?? entry.baseUrl ?? prior?.baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.length === 0) fail(`invalid models.json ${owner}: baseUrl`, `set baseUrl on the model or the provider "${entry.id}" in worker/models.json`);
    const contextWindow = checkNumber(owner, "contextWindow", def.contextWindow) ?? prior?.contextWindow;
    const maxTokens = checkNumber(owner, "maxTokens", def.maxTokens) ?? prior?.maxTokens;
    if (contextWindow === undefined || maxTokens === undefined) fail(`invalid models.json ${owner}: contextWindow/maxTokens`, `new custom models need numeric contextWindow and maxTokens in worker/models.json (overrides of built-in models inherit them)`);
    out.set(def.id, { id: def.id, name: def.name ?? prior?.name ?? def.id, api: def.api ?? prior?.api ?? entry.api, provider: entry.id, baseUrl, input: prior?.input ?? ["text"], contextWindow: contextWindow as number, maxTokens: maxTokens as number, cost: checkCost(owner, def.cost, prior?.cost), reasoning: def.reasoning ?? prior?.reasoning ?? false, thinkingLevelMap: def.thinkingLevelMap ?? prior?.thinkingLevelMap, headers: mergeHeaders(prior?.headers, checkHeaders(owner, "headers", def.headers)) });
  }
  for (const [modelId, override] of Object.entries(entry.overrides)) {
    const current = out.get(modelId);
    if (!current) fail(`unknown models.json provider "${entry.id}" override: ${modelId}`, `available ${entry.id} models: ${[...out.keys()].sort().join(", ")}`);
    const owner = `provider "${entry.id}" override "${modelId}"`;
    out.set(modelId, { ...current, name: override.name ?? current.name, contextWindow: checkNumber(owner, "contextWindow", override.contextWindow) ?? current.contextWindow, maxTokens: checkNumber(owner, "maxTokens", override.maxTokens) ?? current.maxTokens, cost: checkCost(owner, override.cost, current.cost), reasoning: override.reasoning ?? current.reasoning ?? false, thinkingLevelMap: override.thinkingLevelMap ?? current.thinkingLevelMap, headers: mergeHeaders(current.headers, checkHeaders(owner, "headers", override.headers)) });
  }
  return [...out.values()];
}

function forwardStreams(base: Provider): ProviderStreams {
  const out: ProviderStreams = { stream: base.stream as unknown as ProviderStreams["stream"], streamSimple: base.streamSimple as unknown as ProviderStreams["streamSimple"] };
  if (base.fetchDeferred !== undefined) out.fetchDeferred = base.fetchDeferred as unknown as NonNullable<ProviderStreams["fetchDeferred"]>;
  if (base.cancelDeferred !== undefined) out.cancelDeferred = base.cancelDeferred as unknown as NonNullable<ProviderStreams["cancelDeferred"]>;
  return out;
}

function entryProvider(id: string, entry: ProviderEntry, base: Provider | undefined): Provider {
  const models = applyEntry(base?.getModels() ?? [], entry);
  if (base !== undefined) return createProvider({ id, name: entry.name ?? base.name, baseUrl: entry.baseUrl ?? base.baseUrl, headers: mergeHeaders(base.headers as Record<string, string> | undefined, entry.headers), auth: base.auth, models, api: forwardStreams(base) });
  const apis: Partial<Record<Api, ProviderStreams>> = {};
  for (const model of models) {
    if (apis[model.api] !== undefined) continue;
    const impl = getApiProvider(model.api);
    if (impl !== undefined) apis[model.api] = { stream: impl.stream, streamSimple: impl.streamSimple };
  }
  return createProvider({ id, name: entry.name ?? id, baseUrl: entry.baseUrl, headers: entry.headers, auth: { apiKey: envApiKeyAuth(`${id} API key`, [customKeyEnvVar(id)]) }, models, api: apis });
}

const PRECEDENCE = "anthropic,openai,ant-ling,azure-openai-responses,baseten,cerebras,deepseek,fireworks,google,groq,huggingface,kimi-coding,minimax,minimax-cn,mistral,moonshotai,moonshotai-cn,nvidia,opencode,opencode-go,openrouter,qwen-token-plan,qwen-token-plan-cn,qwen-token-plan-individual,together,vercel-ai-gateway,xai,xiaomi,xiaomi-token-plan-ams,xiaomi-token-plan-cn,xiaomi-token-plan-sgp,zai,zai-coding-cn".split(",");

function collection(customDoc: unknown): { models: MutableModels; customs: Set<string> } {
  const models = builtinModels();
  for (const provider of builtinProviders()) if (models.getProvider(provider.id) === undefined) models.setProvider(provider);
  const entries = loadCustomProviders(customDoc);
  for (const [id, entry] of entries) models.setProvider(entryProvider(id, entry, models.getProvider(id)));
  return { models, customs: new Set(entries.keys()) };
}

function orderedIds(models: MutableModels, customs: Set<string>): string[] {
  const head = PRECEDENCE.filter((id) => models.getProvider(id) !== undefined);
  const rest = models.getProviders().map((provider) => provider.id).filter((id) => !head.includes(id) && !customs.has(id));
  return [...head, ...rest, ...[...customs].sort()];
}

export interface KeyedProvider { id: string; catalog: Map<string, RuntimeModel>; }

const MISS = Symbol("model-runtime-cache-miss");
let cachedDoc: unknown = MISS;
let cachedModels: MutableModels | null = null;
let cachedHash = "";
let cachedAll: KeyedProvider[] = [];

export function buildAllProviders(customDoc: unknown = bundledModelsJson): KeyedProvider[] {
  if (customDoc === cachedDoc) return cachedAll;
  let hash = "";
  try {
    hash = JSON.stringify(customDoc ?? null);
  } catch {
    hash = "";
  }
  if (hash !== "" && hash === cachedHash) {
    cachedDoc = customDoc;
    return cachedAll;
  }
  registerBuiltInApiProviders();
  const { models, customs } = collection(customDoc);
  cachedModels = models;
  cachedAll = orderedIds(models, customs).map((id) => {
    const catalog = new Map<string, RuntimeModel>();
    for (const entry of models.getModels(id)) if (!catalog.has(entry.id)) catalog.set(entry.id, toRuntime(id, entry));
    return { id, catalog };
  });
  cachedDoc = customDoc;
  cachedHash = hash;
  return cachedAll;
}

export function keyedProviders(env: RuntimeEnv, customDoc: unknown = bundledModelsJson): KeyedProvider[] {
  return buildAllProviders(customDoc).filter((provider) => resolveProviderKey(env, provider.id) !== undefined);
}

export function providerIdList(providers: KeyedProvider[]): string {
  return providers.map((provider) => provider.id).sort().join(", ");
}

function scopedLookup(providers: KeyedProvider[], providerId: string, modelId: string, keyed: boolean): RuntimeModel {
  const scoped = providers.find((provider) => provider.id === providerId);
  if (!scoped) fail(`unknown provider: ${providerId}`, keyed ? `providers with keys: ${providerIdList(providers)}` : `available providers: ${providerIdList(providers)}`);
  const entry = scoped.catalog.get(modelId);
  if (!entry) fail(`unknown model: ${providerId}/${modelId}`, `available ${providerId} models: ${[...scoped.catalog.keys()].sort().join(", ")}`);
  return entry;
}

export function resolveCatalogModel(providerId: string, modelId: string, customDoc: unknown = bundledModelsJson): RuntimeModel {
  return scopedLookup(buildAllProviders(customDoc), providerId, modelId, false);
}

export interface CatalogLine { provider: string; id: string; name: string; contextWindow: RuntimeModel["contextWindow"]; maxTokens: RuntimeModel["maxTokens"]; }

export function listCatalogModels(customDoc: unknown = bundledModelsJson): CatalogLine[] {
  const out: CatalogLine[] = [];
  for (const provider of buildAllProviders(customDoc)) for (const entry of provider.catalog.values()) out.push({ provider: provider.id, id: entry.id, name: entry.name, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens });
  out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  return out;
}

export function resolveKeyedModel(env: RuntimeEnv, providerId: string, modelId: string, customDoc: unknown = bundledModelsJson): RuntimeModel {
  return scopedLookup(keyedProviders(env, customDoc), providerId, modelId, true);
}

export async function resolveKeyedModelLive(env: RuntimeEnv, providerId: string, modelId: string, customDoc: unknown = bundledModelsJson, _fetchImpl?: typeof fetch): Promise<RuntimeModel> {
  const context: AuthContext = { env: async (name) => env[name] ?? undefined, fileExists: async () => false };
  buildAllProviders(customDoc);
  const scoped = createModels({ authContext: context });
  for (const provider of (cachedModels as MutableModels).getProviders()) scoped.setProvider(provider);
  const found = (await scoped.getAvailable(providerId)).find((model) => model.provider === providerId && model.id === modelId);
  if (found !== undefined) return toRuntime(providerId, found);
  return resolveKeyedModel(env, providerId, modelId, customDoc);
}

function availableList(keyed: KeyedProvider[]): string {
  const ids: string[] = [];
  for (const provider of keyed) for (const modelId of provider.catalog.keys()) ids.push(`${provider.id}/${modelId}`);
  return ids.sort().join(", ");
}

const STUB_TURN_MODEL: RuntimeModel = { id: STUB_MODEL_ID, name: STUB_MODEL_ID, api: "stub", provider: "stub", baseUrl: "", contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function stubRuntime(): ModelRuntime {
  return { model: { ...STUB_TURN_MODEL }, stub: true };
}

export function defaultTurnModel(): RuntimeModel {
  return { ...STUB_TURN_MODEL };
}

export function buildRuntime(env: RuntimeEnv, customDoc: unknown = bundledModelsJson): ModelRuntime {
  const keyed = keyedProviders(env, customDoc);
  if (keyed.length === 0) return stubRuntime();
  const override = typeof env.MODEL_ID === "string" && env.MODEL_ID.length > 0 ? env.MODEL_ID : undefined;
  if (override !== undefined) {
    const exact = keyed.filter((provider) => provider.catalog.has(override));
    if (exact.length === 1) return { model: exact[0].catalog.get(override) as RuntimeModel, stub: false };
    if (exact.length > 1) fail(`ambiguous model id: ${override}`, `it matches providers ${exact.map((provider) => provider.id).sort().join(", ")}; retry as provider/id`);
    const slash = override.indexOf("/");
    if (slash > 0) {
      const scoped = keyed.find((provider) => provider.id === override.slice(0, slash));
      if (scoped) {
        const want = override.slice(slash + 1);
        const entry = scoped.catalog.get(want);
        if (!entry) fail(`unknown model: ${override}`, `available ${scoped.id} models: ${[...scoped.catalog.keys()].sort().join(", ")}`);
        return { model: entry, stub: false };
      }
    }
    fail(`unknown model: ${override}`, `available models: ${availableList(keyed)}`);
  }
  const first = keyed[0];
  const defaultId = [...first.catalog.keys()].sort()[0];
  if (defaultId === undefined) fail(`provider has no models: ${first.id}`, `add models to provider "${first.id}" in worker/models.json or pick another MODEL_ID`);
  return { model: first.catalog.get(defaultId) as RuntimeModel, stub: false };
}

export interface TurnModel {
  model: { id: string; name?: string; api?: string; provider?: string; baseUrl?: string };
  provider: string;
  stub: boolean;
  like: RuntimeModel | Record<string, never>;
}

export function resolveTurnModel(env: RuntimeEnv, catalog: RuntimeModel | null): TurnModel {
  if (catalog === null) {
    const rt = buildRuntime(env);
    if (rt.stub) {
      const d = defaultTurnModel();
      return { model: d, provider: d.provider, stub: true, like: {} };
    }
    return { model: rt.model, provider: rt.model.provider, stub: false, like: rt.model };
  }
  const keyed = keyedProviders(env);
  if (!keyed.some((provider) => provider.id === catalog.provider)) {
    return { model: { id: catalog.id }, provider: catalog.provider, stub: true, like: catalog };
  }
  const m = resolveKeyedModel(env, catalog.provider, catalog.id);
  return { model: m, provider: m.provider, stub: false, like: catalog };
}

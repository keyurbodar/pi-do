import { keyedProviders, listCatalogModels, resolveCatalogModel, THINKING_LEVELS, type RuntimeEnv } from "./model-runtime";
import { readSingleRow, type Sql } from "pi-cf/store/sql-util";

export interface DoctorInfo {
  keyed: boolean;
  models: number;
}

export interface DoctorReport {
  ws: string;
  ok: boolean;
  warnings: string[];
  info: DoctorInfo;
}

function tripleWarnings(who: string, provider: unknown, id: unknown, thinking: unknown): string[] {
  const out: string[] = [];
  const p = typeof provider === "string" ? provider : null;
  const i = typeof id === "string" ? id : null;
  const t = typeof thinking === "string" ? thinking : null;
  if ((p === null) !== (i === null)) out.push(`${who} has half a model default (provider without id, or id without provider)`);
  if (p !== null && i !== null) {
    try {
      resolveCatalogModel(p, i);
    } catch (e) {
      const detail = e !== null && typeof e === "object" && "error" in e && typeof e.error === "string" ? e.error : String(e);
      out.push(`${who} model ${p}/${i} is not in the model catalog: ${detail}`);
    }
  }
  if (t !== null && !(THINKING_LEVELS as readonly string[]).includes(t)) out.push(`${who} thinking level ${t} is unknown`);
  return out;
}

export function reportWorkspaceDoctor(sql: Sql, env: RuntimeEnv, ws: string): DoctorReport {
  const warnings: string[] = [];
  const settings = readSingleRow(sql, "SELECT modelProvider, modelId, thinkingLevel FROM workspace_settings WHERE ws = ? LIMIT 1", ws);
  if (settings !== null) warnings.push(...tripleWarnings("workspace default", settings.modelProvider, settings.modelId, settings.thinkingLevel));
  for (const row of sql.exec("SELECT sid, modelProvider, modelId, thinkingLevel FROM sessions WHERE ws = ?", ws)) {
    if (row === null || typeof row !== "object" || !("sid" in row)) continue;
    const rec = row as Record<string, unknown>;
    warnings.push(...tripleWarnings(`session ${typeof rec.sid === "string" ? rec.sid : "?"}`, rec.modelProvider, rec.modelId, rec.thinkingLevel));
  }
  let models = 0;
  try {
    models = listCatalogModels().length;
  } catch (e) {
    warnings.push(`model catalog unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  let keyed = false;
  try {
    keyed = keyedProviders(env).length > 0;
  } catch {
    keyed = false;
  }
  return { ws, ok: warnings.length === 0, warnings, info: { keyed, models } };
}

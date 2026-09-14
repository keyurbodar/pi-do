// groups.ts — group resolution and fan-out over the shared inbox.
//
// Send-target resolution order everywhere (routes, CLI, the bots' send
// tool): the literal "user" (the human — never a session), session id,
// group id/name/thread, session name, else materialize a new session. A
// group target fans out one inbox row per member (sender excluded)
// sharing the group's thread, then a single alarm wake covers every
// member.
import { ensureGroupsSchema, getGroup, type GroupRow } from "pi-cf/store/groups";
import type { EntriesSql } from "pi-cf/store/entries";

export type SendTarget =
  | { kind: "user" }
  | { kind: "session"; sid: string }
  | { kind: "group"; group: GroupRow }
  | { kind: "unknown"; name: string };

export function resolveSendTarget(sql: EntriesSql, ws: string, sessionExists: (ws: string, sid: string) => boolean, to: string): SendTarget {
  // "user" is the human participant: it must resolve before everything so
  // a bot replying to the human never materializes a session named "user".
  if (to === "user") return { kind: "user" };
  if (sessionExists(ws, to)) return { kind: "session", sid: to };
  ensureGroupsSchema(sql);
  const group = getGroup(sql, ws, to);
  if (group !== null) return { kind: "group", group };
  for (const row of sql.exec("SELECT sid FROM sessions WHERE ws = ? AND name = ? LIMIT 1", ws, to)) {
    if (row !== null && typeof row === "object" && typeof (row as Record<string, unknown>).sid === "string") {
      return { kind: "session", sid: (row as Record<string, unknown>).sid as string };
    }
  }
  return { kind: "unknown", name: to };
}

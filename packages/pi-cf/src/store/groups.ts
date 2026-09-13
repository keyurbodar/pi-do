// groups.ts — bot crews: named member sets over the shared inbox.
//
// A group is a row plus memberships; there is no separate transport. A
// message to the group fans out into one pi_inbox row per member (sender
// excluded), all carrying the group's thread key — so every member's wake
// turn sees every message in the channel, and the existing inbox wake,
// dedupe, and delivered-marking machinery does the rest.
import type { EntriesSql } from "./entries.ts";
import { readSingleRow } from "./sql-util.ts";

export const GROUPS_DDL = "CREATE TABLE IF NOT EXISTS pi_groups(ws TEXT, id TEXT PRIMARY KEY, name TEXT NOT NULL, thread TEXT NOT NULL, created_at TEXT NOT NULL)";
export const GROUP_MEMBERS_DDL = "CREATE TABLE IF NOT EXISTS pi_group_members(ws TEXT, group_id TEXT, sid TEXT, PRIMARY KEY(ws, group_id, sid))";

export function ensureGroupsSchema(sql: EntriesSql): void {
  sql.exec(GROUPS_DDL);
  sql.exec(GROUP_MEMBERS_DDL);
}

export interface GroupRow {
  id: string;
  ws: string;
  name: string;
  thread: string;
}

const SELECT_GROUP = "SELECT id, ws, name, thread FROM pi_groups";

function toGroupRow(row: unknown): GroupRow | null {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.ws !== "string" || typeof r.name !== "string" || typeof r.thread !== "string") return null;
  return { id: r.id, ws: r.ws, name: r.name, thread: r.thread };
}

export function getGroup(sql: EntriesSql, ws: string, ref: string): GroupRow | null {
  // ref is a group id or its unique name.
  return toGroupRow(readSingleRow(sql, `${SELECT_GROUP} WHERE ws = ? AND (id = ? OR name = ?) LIMIT 1`, ws, ref, ref));
}

export function listGroups(sql: EntriesSql, ws: string): Array<GroupRow & { members: string[] }> {
  const out: Array<GroupRow & { members: string[] }> = [];
  for (const row of sql.exec(`${SELECT_GROUP} WHERE ws = ? ORDER BY created_at`, ws)) {
    const parsed = toGroupRow(row);
    if (parsed === null) continue;
    out.push({ ...parsed, members: listMembers(sql, ws, parsed.id) });
  }
  return out;
}

export function listMembers(sql: EntriesSql, ws: string, groupId: string): string[] {
  const out: string[] = [];
  for (const row of sql.exec("SELECT sid FROM pi_group_members WHERE ws = ? AND group_id = ? ORDER BY rowid", ws, groupId)) {
    if (row !== null && typeof row === "object") {
      const sid = (row as Record<string, unknown>).sid;
      if (typeof sid === "string") out.push(sid);
    }
  }
  return out;
}

export function createGroup(sql: EntriesSql, ws: string, name: string, members: string[]): GroupRow {
  ensureGroupsSchema(sql);
  const id = crypto.randomUUID();
  sql.exec("INSERT INTO pi_groups(ws, id, name, thread, created_at) VALUES (?, ?, ?, ?, ?)", ws, id, name, `group-${id}`, new Date().toISOString());
  for (const sid of members) {
    sql.exec("INSERT OR IGNORE INTO pi_group_members(ws, group_id, sid) VALUES (?, ?, ?)", ws, id, sid);
  }
  return getGroup(sql, ws, id) as GroupRow;
}

export function deleteGroup(sql: EntriesSql, ws: string, id: string): boolean {
  ensureGroupsSchema(sql);
  if (getGroup(sql, ws, id) === null) return false;
  sql.exec("DELETE FROM pi_groups WHERE ws = ? AND id = ?", ws, id);
  sql.exec("DELETE FROM pi_group_members WHERE ws = ? AND group_id = ?", ws, id);
  return true;
}

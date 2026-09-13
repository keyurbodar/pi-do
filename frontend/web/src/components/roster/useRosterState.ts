// Local roster state for the sidebar. Server sessions are the truth for a
// bot's existence, name, and backstory (hydrated from GET /sessions on load);
// localStorage keeps only the client-side overlay keyed by sid — identity,
// pinned/order, unread, preview, and the fixture-local detail fields — plus
// the local-only groups and the hidden list for client-side deletes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createBotSession,
  evictSession,
  listSessions,
  type SessionSummary,
} from "../../lib/session";
import {
  type BloubIdentity,
  type RosterBot,
  type RosterGroup,
} from "../../lib/roster";
import { hashName } from "./identicon";
import { BLOUB_COLORS, BLOUB_EXPRESSIONS, BLOUB_SHAPES } from "./identity";

const STORAGE_KEY = "pi-do.roster.v3";

/** Client-only fields; the server session row owns id/name/backstory. */
type BotOverlay = Partial<Omit<RosterBot, "id">>;

interface PersistedRoster {
  overlay: Record<string, BotOverlay>;
  order: string[];
  hidden: string[];
  groups: RosterGroup[];
  activeId: string | null;
  railCollapsed: boolean;
}

function makeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function loadPersisted(): PersistedRoster {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<PersistedRoster>;
      return {
        overlay:
          parsed.overlay !== null && typeof parsed.overlay === "object" && !Array.isArray(parsed.overlay)
            ? parsed.overlay
            : {},
        order: Array.isArray(parsed.order) ? parsed.order.filter((id): id is string => typeof id === "string") : [],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((id): id is string => typeof id === "string") : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
        railCollapsed: parsed.railCollapsed === true,
      };
    }
  } catch {
    // Corrupt or unavailable storage: start from an empty overlay.
  }
  return { overlay: {}, order: [], hidden: [], groups: [], activeId: null, railCollapsed: false };
}

/** Deterministic bloub identity for a session with no overlay entry. */
function bloubForId(sid: string): BloubIdentity {
  const hash = hashName(sid);
  return {
    shape: BLOUB_SHAPES[hash % BLOUB_SHAPES.length] ?? "cercle",
    color: BLOUB_COLORS[(hash >> 3) % BLOUB_COLORS.length] ?? "encre",
    expression: BLOUB_EXPRESSIONS[(hash >> 7) % BLOUB_EXPRESSIONS.length] ?? "neutre",
  };
}

/** The dialog stores persona and instructions as one backstory; hydration
 * splits on the first blank line so the details panel can show both. */
function splitBackstory(backstory: string | null): { persona?: string; instructions?: string } {
  if (backstory === null) return {};
  const split = backstory.indexOf("\n\n");
  if (split < 0) return { persona: backstory };
  return { persona: backstory.slice(0, split), instructions: backstory.slice(split + 2) };
}

function toBot(session: SessionSummary, overlay: BotOverlay | undefined): RosterBot {
  const created = session.created === null ? Number.NaN : Date.parse(session.created);
  const backstory = splitBackstory(session.backstory);
  return {
    name: session.name ?? session.sid,
    bloub: bloubForId(session.sid),
    preview: "",
    updatedAt: Number.isNaN(created) ? 0 : created,
    presence: session.openRun ? "working" : "idle",
    unread: 0,
    pinned: false,
    persona: backstory.persona,
    instructions: backstory.instructions,
    ...overlay,
    id: session.sid,
  };
}

export interface RosterApi {
  bots: RosterBot[];
  groups: RosterGroup[];
  activeId: string | null;
  railCollapsed: boolean;
  setActive: (id: string | null) => void;
  toggleRail: () => void;
  addBot: (name: string, identity: BloubIdentity, extra?: Partial<RosterBot>) => Promise<RosterBot>;
  addGroup: (name: string, memberIds: string[]) => RosterGroup;
  deleteBot: (id: string) => void;
  deleteGroup: (id: string) => void;
  setItemPinned: (id: string, pinned: boolean) => void;
  setActivity: (id: string, preview: string, presence: RosterBot["presence"]) => void;
  updateBot: (id: string, patch: Partial<RosterBot>) => void;
  reorderItem: (dragId: string, targetId: string | null) => void;
}

export function useRosterState(): RosterApi {
  const [state, setState] = useState<PersistedRoster>(loadPersisted);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const sessionsRef = useRef<SessionSummary[] | null>(null);
  sessionsRef.current = sessions;

  useEffect(() => {
    let cancelled = false;
    listSessions().then(
      (rows) => {
        if (cancelled) return;
        sessionsRef.current = rows;
        setSessions(rows);
      },
      () => {
        // Worker unreachable: the roster stays empty and the app-level boot
        // gate already surfaces the connection error.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or unavailable: the in-memory roster keeps working.
    }
  }, [state]);

  const bots = useMemo(() => {
    if (sessions === null) return [];
    const hidden = new Set(state.hidden);
    const visible = sessions.filter((session) => !hidden.has(session.sid));
    const bySid = new Map(visible.map((session) => [session.sid, session]));
    const ordered: SessionSummary[] = [];
    for (const sid of state.order) {
      const session = bySid.get(sid);
      if (session === undefined) continue;
      ordered.push(session);
      bySid.delete(sid);
    }
    for (const session of visible) {
      if (bySid.delete(session.sid)) ordered.push(session);
    }
    return ordered.map((session) => toBot(session, state.overlay[session.sid]));
  }, [sessions, state.hidden, state.order, state.overlay]);

  const activeId = useMemo(() => {
    if (state.activeId === null) return null;
    if (bots.some((bot) => bot.id === state.activeId)) return state.activeId;
    if (state.groups.some((group) => group.id === state.activeId)) return state.activeId;
    return null;
  }, [state.activeId, bots, state.groups]);

  const setActive = useCallback((id: string | null) => {
    setState((prev) => {
      // Selecting a bot marks it read: its unread count resets and persists.
      const entry = id === null ? undefined : prev.overlay[id];
      const hasUnread = entry !== undefined && typeof entry.unread === "number" && entry.unread > 0;
      const overlay = hasUnread ? { ...prev.overlay, [id as string]: { ...entry, unread: 0 } } : prev.overlay;
      if (prev.activeId === id && overlay === prev.overlay) return prev;
      return { ...prev, activeId: id, overlay };
    });
  }, []);

  const toggleRail = useCallback(() => {
    setState((prev) => ({ ...prev, railCollapsed: !prev.railCollapsed }));
  }, []);

  const addBot = useCallback(async (name: string, identity: BloubIdentity, extra?: Partial<RosterBot>) => {
    const persona = extra?.persona?.trim() ?? "";
    const instructions = extra?.instructions?.trim() ?? "";
    const backstory = [persona, instructions].filter((part) => part.length > 0).join("\n\n");
    const handle = await createBotSession(name, backstory.length > 0 ? backstory : null);
    const summary: SessionSummary = {
      sid: handle.sessionId,
      name,
      backstory: backstory.length > 0 ? backstory : null,
      created: new Date().toISOString(),
      openRun: false,
      head: 0,
      count: 0,
    };
    sessionsRef.current = [...(sessionsRef.current ?? []), summary];
    setSessions(sessionsRef.current);
    const { id: _drop, ...rest } = extra ?? {};
    const overlayEntry: BotOverlay = {
      ...rest,
      bloub: identity,
      preview: extra?.preview ?? "Say hello to your new bot",
      updatedAt: Date.now(),
      presence: extra?.presence ?? "idle",
      unread: 0,
      pinned: extra?.pinned ?? false,
      modelId: extra?.modelId ?? "default",
      avatarVariant: extra?.avatarVariant ?? "bloub",
      identiconStyle: extra?.identiconStyle ?? 0,
      voiceEnabled: extra?.voiceEnabled ?? false,
      memory: extra?.memory ?? [],
      sandbox: extra?.sandbox ?? "none",
      toolOverrides: extra?.toolOverrides ?? {},
      usageCap: extra?.usageCap ?? 0,
      channels: extra?.channels ?? {},
    };
    setState((prev) => ({
      ...prev,
      overlay: { ...prev.overlay, [handle.sessionId]: overlayEntry },
      order: [...prev.order, handle.sessionId],
      activeId: handle.sessionId,
    }));
    return toBot(summary, overlayEntry);
  }, []);

  const addGroup = useCallback((name: string, memberIds: string[]) => {
    const group: RosterGroup = { id: makeId("group"), name, memberIds, updatedAt: Date.now() };
    setState((prev) => ({ ...prev, groups: [...prev.groups, group], activeId: group.id }));
    return group;
  }, []);

  const deleteBot = useCallback((id: string) => {
    // No server delete: the session stays server-side, the row hides locally.
    evictSession(id);
    setState((prev) => ({
      ...prev,
      hidden: prev.hidden.includes(id) ? prev.hidden : [...prev.hidden, id],
      order: prev.order.filter((sid) => sid !== id),
      groups: prev.groups.map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((memberId) => memberId !== id),
      })),
      activeId: prev.activeId === id ? null : prev.activeId,
    }));
  }, []);

  const deleteGroup = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      groups: prev.groups.filter((group) => group.id !== id),
      activeId: prev.activeId === id ? null : prev.activeId,
    }));
  }, []);

  const setActivity = useCallback((id: string, preview: string, presence: RosterBot["presence"]) => {
    setState((prev) => {
      const entry = prev.overlay[id];
      if (entry !== undefined && entry.preview === preview && entry.presence === presence) return prev;
      return {
        ...prev,
        overlay: {
          ...prev.overlay,
          [id]: { ...entry, preview, presence, updatedAt: Date.now() },
        },
      };
    });
  }, []);

  const setItemPinned = useCallback((id: string, pinned: boolean) => {
    setState((prev) => ({
      ...prev,
      overlay: { ...prev.overlay, [id]: { ...prev.overlay[id], pinned } },
    }));
  }, []);

  const updateBot = useCallback((id: string, patch: Partial<RosterBot>) => {
    const { id: _drop, ...rest } = patch;
    setState((prev) => ({
      ...prev,
      overlay: { ...prev.overlay, [id]: { ...prev.overlay[id], ...rest } },
    }));
  }, []);

  const reorderItem = useCallback((dragId: string, targetId: string | null) => {
    setState((prev) => {
      if (targetId !== null && dragId === targetId) return prev;
      const hidden = new Set(prev.hidden);
      const visible = (sessionsRef.current ?? []).filter((session) => !hidden.has(session.sid));
      const bySid = new Map(visible.map((session) => [session.sid, session]));
      const sids: string[] = [];
      for (const sid of prev.order) {
        if (bySid.delete(sid)) sids.push(sid);
      }
      for (const session of visible) {
        if (bySid.delete(session.sid)) sids.push(session.sid);
      }
      const dragBot = sids.includes(dragId);
      const dragGroup = !dragBot && prev.groups.some((group) => group.id === dragId);
      if (!dragBot && !dragGroup) return prev;
      let order = prev.order;
      if (dragBot) {
        const without = sids.filter((sid) => sid !== dragId);
        const targetIndex = targetId === null ? -1 : without.indexOf(targetId);
        order =
          targetId === null
            ? [...without, dragId]
            : targetIndex < 0
              ? [...without, dragId]
              : [...without.slice(0, targetIndex), dragId, ...without.slice(targetIndex)];
      }
      // Groups keep their own array order for row stability.
      let groups = prev.groups;
      if (dragGroup) {
        const without = prev.groups.filter((group) => group.id !== dragId);
        const targetIndex = targetId === null ? -1 : without.findIndex((group) => group.id === targetId);
        const group = prev.groups.find((candidate) => candidate.id === dragId);
        if (group !== undefined) {
          groups =
            targetId === null
              ? [...without, group]
              : targetIndex < 0
                ? [...without, group]
                : [...without.slice(0, targetIndex), group, ...without.slice(targetIndex)];
        }
      }
      return { ...prev, order, groups };
    });
  }, []);

  return useMemo(
    () => ({
      bots,
      groups: state.groups,
      activeId,
      railCollapsed: state.railCollapsed,
      setActive,
      toggleRail,
      addBot,
      addGroup,
      deleteBot,
      deleteGroup,
      setItemPinned,
      setActivity,
      updateBot,
      reorderItem,
    }),
    [
      bots,
      state.groups,
      activeId,
      state.railCollapsed,
      setActive,
      toggleRail,
      addBot,
      addGroup,
      deleteBot,
      deleteGroup,
      setItemPinned,
      setActivity,
      updateBot,
      reorderItem,
    ],
  );
}

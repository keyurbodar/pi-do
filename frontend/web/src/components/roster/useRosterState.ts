// Local roster state for the sidebar. Akeru backs this with an Effect atom
// store (rosterStore.ts, MIT); here it is plain React state persisted to
// localStorage, seeded from loadRoster() until real sessions replace it.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadRoster,
  type BloubIdentity,
  type RosterBot,
  type RosterGroup,
} from "../../lib/roster";

const STORAGE_KEY = "pi-do.roster.v2";

interface PersistedRoster {
  bots: RosterBot[];
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
  const seed = loadRoster();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<PersistedRoster>;
      if (Array.isArray(parsed.bots) && Array.isArray(parsed.groups)) {
        // Unknown stored fields from older persists are ignored.
        return {
          bots: parsed.bots,
          groups: parsed.groups,
          activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
          railCollapsed: parsed.railCollapsed === true,
        };
      }
    }
  } catch {
    // Corrupt or unavailable storage: fall back to the seed roster.
  }
  return {
    bots: seed.bots,
    groups: seed.groups,
    activeId: null,
    railCollapsed: false,
  };
}

export interface RosterApi {
  bots: RosterBot[];
  groups: RosterGroup[];
  activeId: string | null;
  railCollapsed: boolean;
  setActive: (id: string | null) => void;
  toggleRail: () => void;
  addBot: (name: string, identity: BloubIdentity, extra?: Partial<RosterBot>) => RosterBot;
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

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or unavailable: the in-memory roster keeps working.
    }
  }, [state]);

  const setActive = useCallback((id: string | null) => {
    setState((prev) => {
      // Selecting a bot marks it read: its unread count resets and persists.
      const hasUnread = id !== null && prev.bots.some((bot) => bot.id === id && bot.unread > 0);
      const bots = hasUnread
        ? prev.bots.map((bot) => (bot.id === id ? { ...bot, unread: 0 } : bot))
        : prev.bots;
      if (prev.activeId === id && bots === prev.bots) return prev;
      return { ...prev, activeId: id, bots };
    });
  }, []);

  const toggleRail = useCallback(() => {
    setState((prev) => ({ ...prev, railCollapsed: !prev.railCollapsed }));
  }, []);

  const addBot = useCallback((name: string, identity: BloubIdentity, extra?: Partial<RosterBot>) => {
    const bot: RosterBot = {
      ...extra,
      // Identity and generated fields always win over the extra bag.
      id: makeId("bot"),
      name,
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
    setState((prev) => ({ ...prev, bots: [...prev.bots, bot], activeId: bot.id }));
    return bot;
  }, []);

  const addGroup = useCallback((name: string, memberIds: string[]) => {
    const group: RosterGroup = { id: makeId("group"), name, memberIds, updatedAt: Date.now() };
    setState((prev) => ({ ...prev, groups: [...prev.groups, group], activeId: group.id }));
    return group;
  }, []);

  const deleteBot = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.filter((bot) => bot.id !== id),
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
    setState((prev) => ({
      ...prev,
      bots: prev.bots.map((bot) =>
        bot.id === id && (bot.preview !== preview || bot.presence !== presence)
          ? { ...bot, preview, presence, updatedAt: Date.now() }
          : bot,
      ),
    }));
  }, []);

  const setItemPinned = useCallback((id: string, pinned: boolean) => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, pinned } : bot)),
    }));
  }, []);

  const updateBot = useCallback((id: string, patch: Partial<RosterBot>) => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, ...patch, id: bot.id } : bot)),
    }));
  }, []);

  const reorderItem = useCallback((dragId: string, targetId: string | null) => {
    setState((prev) => {
      if (targetId !== null && dragId === targetId) return prev;
      const dragBot = prev.bots.find((bot) => bot.id === dragId);
      const dragGroup = dragBot === undefined ? prev.groups.find((group) => group.id === dragId) : undefined;
      if (dragBot === undefined && dragGroup === undefined) return prev;
      // Flat order: drop the dragged bot before the target bot, or append.
      let bots = prev.bots;
      if (dragBot !== undefined) {
        const without = prev.bots.filter((bot) => bot.id !== dragId);
        if (targetId === null) {
          bots = [...without, dragBot];
        } else {
          const targetIndex = without.findIndex((bot) => bot.id === targetId);
          bots =
            targetIndex < 0
              ? [...without, dragBot]
              : [...without.slice(0, targetIndex), dragBot, ...without.slice(targetIndex)];
        }
      }
      // Groups keep their own array order for row stability.
      let groups = prev.groups;
      if (dragGroup !== undefined) {
        const without = prev.groups.filter((group) => group.id !== dragId);
        if (targetId === null) {
          groups = [...without, dragGroup];
        } else {
          const targetIndex = without.findIndex((group) => group.id === targetId);
          groups =
            targetIndex < 0
              ? [...without, dragGroup]
              : [...without.slice(0, targetIndex), dragGroup, ...without.slice(targetIndex)];
        }
      }
      return { ...prev, bots, groups };
    });
  }, []);

  return useMemo(
    () => ({
      bots: state.bots,
      groups: state.groups,
      activeId: state.activeId,
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
      state.bots,
      state.groups,
      state.activeId,
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

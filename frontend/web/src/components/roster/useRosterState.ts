// Local roster state for the sidebar. Akeru backs this with an Effect atom
// store (rosterStore.ts, MIT); here it is plain React state persisted to
// localStorage, seeded from loadRoster() until real sessions replace it.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadRoster,
  type BloubIdentity,
  type RosterBot,
  type RosterGroup,
  type RosterSection,
} from "../../lib/roster";

const STORAGE_KEY = "pi-do.roster.v2";

interface PersistedRoster {
  bots: RosterBot[];
  groups: RosterGroup[];
  sections: RosterSection[];
  activeId: string | null;
  railCollapsed: boolean;
  collapsedSections: string[];
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
      if (Array.isArray(parsed.bots) && Array.isArray(parsed.groups) && Array.isArray(parsed.sections)) {
        return {
          bots: parsed.bots,
          groups: parsed.groups,
          sections: parsed.sections,
          activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
          railCollapsed: parsed.railCollapsed === true,
          collapsedSections: Array.isArray(parsed.collapsedSections) ? parsed.collapsedSections : [],
        };
      }
    }
  } catch {
    // Corrupt or unavailable storage: fall back to the seed roster.
  }
  return {
    bots: seed.bots,
    groups: seed.groups,
    sections: seed.sections,
    activeId: null,
    railCollapsed: false,
    collapsedSections: [],
  };
}

export interface RosterApi {
  bots: RosterBot[];
  groups: RosterGroup[];
  sections: RosterSection[];
  activeId: string | null;
  railCollapsed: boolean;
  isSectionCollapsed: (sectionId: string) => boolean;
  setActive: (id: string | null) => void;
  toggleRail: () => void;
  toggleSectionCollapsed: (sectionId: string) => void;
  addBot: (name: string, identity: BloubIdentity) => RosterBot;
  addGroup: (name: string, memberIds: string[]) => RosterGroup;
  addSection: (name: string) => RosterSection;
  deleteBot: (id: string) => void;
  deleteGroup: (id: string) => void;
  deleteSection: (id: string) => void;
  setItemPinned: (id: string, pinned: boolean) => void;
  moveItem: (id: string, sectionId: string | null) => void;
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

  const toggleSectionCollapsed = useCallback((sectionId: string) => {
    setState((prev) => ({
      ...prev,
      collapsedSections: prev.collapsedSections.includes(sectionId)
        ? prev.collapsedSections.filter((id) => id !== sectionId)
        : [...prev.collapsedSections, sectionId],
    }));
  }, []);

  const addBot = useCallback((name: string, identity: BloubIdentity) => {
    const bot: RosterBot = {
      id: makeId("bot"),
      name,
      bloub: identity,
      preview: "Say hello to your new bot",
      updatedAt: Date.now(),
      presence: "idle",
      unread: 0,
      pinned: false,
    };
    setState((prev) => ({ ...prev, bots: [...prev.bots, bot], activeId: bot.id }));
    return bot;
  }, []);

  const addGroup = useCallback((name: string, memberIds: string[]) => {
    const group: RosterGroup = { id: makeId("group"), name, memberIds, updatedAt: Date.now() };
    setState((prev) => ({ ...prev, groups: [...prev.groups, group], activeId: group.id }));
    return group;
  }, []);

  const addSection = useCallback((name: string) => {
    const section: RosterSection = { id: makeId("section"), name, childIds: [] };
    setState((prev) => ({ ...prev, sections: [...prev.sections, section] }));
    return section;
  }, []);

  const deleteBot = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.filter((bot) => bot.id !== id),
      groups: prev.groups.map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((memberId) => memberId !== id),
      })),
      sections: prev.sections.map((section) => ({
        ...section,
        childIds: section.childIds.filter((childId) => childId !== id),
      })),
      activeId: prev.activeId === id ? null : prev.activeId,
    }));
  }, []);

  const deleteGroup = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      groups: prev.groups.filter((group) => group.id !== id),
      sections: prev.sections.map((section) => ({
        ...section,
        childIds: section.childIds.filter((childId) => childId !== id),
      })),
      activeId: prev.activeId === id ? null : prev.activeId,
    }));
  }, []);

  const deleteSection = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      sections: prev.sections.filter((section) => section.id !== id),
      collapsedSections: prev.collapsedSections.filter((collapsed) => collapsed !== id),
    }));
  }, []);

  const setItemPinned = useCallback((id: string, pinned: boolean) => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, pinned } : bot)),
    }));
  }, []);

  const moveItem = useCallback((id: string, sectionId: string | null) => {
    setState((prev) => ({
      ...prev,
      sections: prev.sections.map((section) => {
        const withoutId = section.childIds.filter((childId) => childId !== id);
        return section.id === sectionId ? { ...section, childIds: [...withoutId, id] } : { ...section, childIds: withoutId };
      }),
    }));
  }, []);

  const isSectionCollapsed = useCallback(
    (sectionId: string) => state.collapsedSections.includes(sectionId),
    [state.collapsedSections],
  );

  return useMemo(
    () => ({
      bots: state.bots,
      groups: state.groups,
      sections: state.sections,
      activeId: state.activeId,
      railCollapsed: state.railCollapsed,
      isSectionCollapsed,
      setActive,
      toggleRail,
      toggleSectionCollapsed,
      addBot,
      addGroup,
      addSection,
      deleteBot,
      deleteGroup,
      deleteSection,
      setItemPinned,
      moveItem,
    }),
    [
      state.bots,
      state.groups,
      state.sections,
      state.activeId,
      state.railCollapsed,
      isSectionCollapsed,
      setActive,
      toggleRail,
      toggleSectionCollapsed,
      addBot,
      addGroup,
      addSection,
      deleteBot,
      deleteGroup,
      deleteSection,
      setItemPinned,
      moveItem,
    ],
  );
}

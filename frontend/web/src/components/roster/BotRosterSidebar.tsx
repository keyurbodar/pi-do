// Roster sidebar, ported from akeru's BotRosterSidebar.tsx (MIT) and stripped
// of its Effect/atom store, router, drag-and-drop, and base-ui menu layers:
// plain React state + Tailwind utilities against the lib/roster.ts contract.
// Kept from akeru: iMessage-style rows (avatar, name, relative timestamp,
// one-line preview, presence, unread badge), pinned area, collapsible
// sections, search filtering, icon rail, and the create menu.
// Fixture-local additions: keyboard shortcuts, HTML5 drag-and-drop reorder,
// per-bot details/channels/memory/tools sheets, and a delete confirm dialog.
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PanelLeftIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { RosterBot, RosterGroup, RosterSection } from "../../lib/roster";
import BotAvatar from "./BotAvatar";
import { BotChannelsSheet } from "./BotChannelsSheet";
import { BotDetailsPanel } from "./BotDetailsPanel";
import { BotMemorySheet } from "./BotMemorySheet";
import { BotToolsSheet } from "./BotToolsSheet";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { GroupMemberStack } from "./GroupMemberStack";
import { NewBotDialog } from "./NewBotDialog";
import { NewGroupDialog } from "./NewGroupDialog";
import { cn, filterRosterBots, filterRosterGroups, formatRosterTimestamp, groupMembers } from "./roster.logic";
import type { RosterApi } from "./useRosterState";

type MenuTarget =
  | { kind: "bot"; id: string; pinned: boolean }
  | { kind: "group"; id: string }
  | { kind: "section"; id: string };

type PendingDelete = { kind: "bot" | "group" | "section"; id: string; label: string };

/** Three staggered blinking dots for the typing presence. */
function TypingDots() {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-sidebar-muted-foreground animate-blink"
          style={{ animationDelay: `${index * 200}ms` }}
        />
      ))}
    </span>
  );
}

function BotRow({
  bot,
  isActive,
  selected = false,
  onSelect,
  onMenu,
}: {
  bot: RosterBot;
  isActive: boolean;
  selected?: boolean;
  onSelect: () => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const sleeping = bot.presence === "sleeping";
  const typing = bot.presence === "typing";
  return (
    <div
      className="mx-2 mb-1"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        data-testid={`roster-row-${bot.id}`}
        title={bot.name}
        aria-current={isActive || undefined}
        onClick={onSelect}
        className={cn(
          "flex h-[64px] w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive
            ? "bg-white/[0.08] text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-accent",
          sleeping && "opacity-60",
          selected && !isActive && "ring-1 ring-ring",
        )}
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
          {/* Sleeping blobs collapse to a dot in the bloub engine; render the
              idle body dimmed so the roster never reads as broken. */}
          {bot.avatarVariant === "upload" && bot.avatarImage ? (
            <img src={bot.avatarImage} alt="" className="size-10 shrink-0 rounded-full object-cover" />
          ) : (
            <BotAvatar identity={bot.bloub} presence={sleeping ? "idle" : bot.presence} size={48} className="shrink-0" />
          )}
          {bot.presence === "working" ? (
            <span className="absolute -bottom-px -right-px size-2 rounded-full bg-success ring-1 ring-sidebar" />
          ) : null}
          {bot.unread > 0 ? (
            <span
              data-testid={`roster-unread-${bot.id}`}
              className="absolute -top-1 -right-1 z-10 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-sidebar"
            >
              {bot.unread}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-sidebar-foreground">
              {bot.name}
            </span>
            {bot.pinned ? <PinIcon className="size-3 shrink-0 text-sidebar-muted-foreground" /> : null}
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
              {formatRosterTimestamp(bot.updatedAt)}
            </span>
          </span>
          {typing ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <TypingDots />
              <span className="min-w-0 flex-1 truncate text-sm text-sidebar-muted-foreground">Typing…</span>
            </span>
          ) : (
            <span className="min-w-0 truncate text-sm text-sidebar-muted-foreground">{bot.preview}</span>
          )}
        </span>
      </button>
    </div>
  );
}

function GroupRow({
  group,
  bots,
  isActive,
  selected = false,
  onSelect,
  onMenu,
}: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  isActive: boolean;
  selected?: boolean;
  onSelect: () => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const members = groupMembers(group, bots);
  return (
    <div
      className="mx-2 mb-1"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        data-testid={`roster-row-${group.id}`}
        title={group.name}
        aria-current={isActive || undefined}
        onClick={onSelect}
        className={cn(
          "flex h-[64px] w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive
            ? "bg-white/[0.08] text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-accent",
          selected && !isActive && "ring-1 ring-ring",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center">
          <GroupMemberStack group={group} bots={bots} sizeClassName="size-9" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-sidebar-foreground">
              {group.name}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
              {formatRosterTimestamp(group.updatedAt)}
            </span>
          </span>
          <span className="min-w-0 truncate text-sm text-sidebar-muted-foreground">
            {members.map((member) => member.name).join(", ")}
          </span>
        </span>
      </button>
    </div>
  );
}

function SectionHeader({
  name,
  count,
  collapsed,
  onToggle,
  onMenu,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  return (
    <div
      className="mx-2 flex h-8 items-center rounded-md hover:bg-accent"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-3 text-left text-xs font-medium text-sidebar-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
        <span className="truncate">{name}</span>
        <span className="tabular-nums">{count}</span>
      </button>
    </div>
  );
}

/** Floating action menu shared by rows and sections; opens on right-click only. */
function ContextMenu({
  menu,
  sections,
  childSectionId,
  onPin,
  onMove,
  onDelete,
  onDetails,
  onChannels,
  onMemory,
  onTools,
  onClose,
}: {
  menu: { x: number; y: number; target: MenuTarget };
  sections: readonly RosterSection[];
  childSectionId: string | null;
  onPin: (pinned: boolean) => void;
  onMove: (sectionId: string | null) => void;
  onDelete: () => void;
  onDetails: () => void;
  onChannels: () => void;
  onMemory: () => void;
  onTools: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const itemClassName =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent";
  const isSection = menu.target.kind === "section";
  const pinnedBot = menu.target.kind === "bot" ? menu.target : null;
  const isBot = menu.target.kind === "bot";

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
        className="absolute min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-float)]"
      >
        {isBot ? (
          <>
            <button type="button" role="menuitem" data-testid="menu-details" className={itemClassName} onClick={() => { onDetails(); onClose(); }}>
              Details
            </button>
            <button type="button" role="menuitem" data-testid="menu-channels" className={itemClassName} onClick={() => { onChannels(); onClose(); }}>
              Channels
            </button>
            <button type="button" role="menuitem" data-testid="menu-memory" className={itemClassName} onClick={() => { onMemory(); onClose(); }}>
              Memory
            </button>
            <button type="button" role="menuitem" data-testid="menu-tools" className={itemClassName} onClick={() => { onTools(); onClose(); }}>
              Tools
            </button>
            <div className="my-1 h-px bg-border" />
          </>
        ) : null}
        {pinnedBot !== null ? (
          <button type="button" role="menuitem" data-testid="menu-pin" className={itemClassName} onClick={() => { onPin(!pinnedBot.pinned); onClose(); }}>
            <PinIcon className="size-3.5" />
            {pinnedBot.pinned ? "Unpin" : "Pin"}
          </button>
        ) : null}
        {!isSection && sections.length > 0 ? (
          <>
            <div className="my-1 h-px bg-border" />
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                role="menuitem"
                data-testid={`menu-move-${section.id}`}
                className={itemClassName}
                onClick={() => { onMove(section.id); onClose(); }}
              >
                <UsersIcon className="size-3.5" />
                Move to {section.name}
                {childSectionId === section.id ? <span className="ml-auto text-xs text-muted-foreground">✓</span> : null}
              </button>
            ))}
            {childSectionId !== null ? (
              <button type="button" role="menuitem" className={itemClassName} onClick={() => { onMove(null); onClose(); }}>
                No section
              </button>
            ) : null}
            <div className="my-1 h-px bg-border" />
          </>
        ) : null}
        <button type="button" role="menuitem" data-testid="menu-delete" className={cn(itemClassName, "text-destructive hover:bg-destructive/15")} onClick={() => { onDelete(); onClose(); }}>
          <Trash2Icon className="size-3.5" />
          {isSection ? "Delete section" : "Delete"}
        </button>
      </div>
    </div>
  );
}

/**
 * HTML5 draggable wrapper for sidebar rows. Renders the drop-indicator line
 * above or below the row while a drag hovers it; drops persist through
 * api.reorderItem (no new deps).
 */
function ReorderRow({
  id,
  draggable,
  indicator,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  children,
}: {
  id: string;
  draggable: boolean;
  indicator: "before" | "after" | null;
  onDragStart: (id: string) => (event: DragEvent) => void;
  onDragOver: (id: string) => (event: DragEvent) => void;
  onDrop: (id: string) => (event: DragEvent) => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  if (!draggable) return <>{children}</>;
  return (
    <div
      draggable
      data-testid={`roster-drag-${id}`}
      onDragStart={onDragStart(id)}
      onDragOver={onDragOver(id)}
      onDrop={onDrop(id)}
      onDragEnd={onDragEnd}
    >
      {indicator === "before" ? (
        <div data-testid="drop-indicator" className="mx-2 mb-1 h-0.5 rounded bg-primary" />
      ) : null}
      {children}
      {indicator === "after" ? (
        <div data-testid="drop-indicator" className="mx-2 mb-1 h-0.5 rounded bg-primary" />
      ) : null}
    </div>
  );
}

function UserProfileFooter({ collapsed = false }: { collapsed?: boolean }) {
  // Akeru hides footer labels in icon-collapsed mode (group-data-[collapsible=icon]:hidden)
  // and centers the remaining icon; match that: initials circle only in the rail.
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-t border-border py-3",
        collapsed ? "justify-center" : "px-3",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
        AS
      </span>
      {collapsed ? null : (
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
          Armand Segall
        </span>
      )}
    </footer>
  );
}

const byRecency = (a: RosterBot, b: RosterBot) => b.updatedAt - a.updatedAt;

export function BotRosterSidebar({ api }: { api: RosterApi }) {
  const { bots, groups, sections, activeId, railCollapsed } = api;
  const [query, setQuery] = useState("");
  const [plusOpen, setPlusOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [detailsBotId, setDetailsBotId] = useState<string | null>(null);
  const [channelsBotId, setChannelsBotId] = useState<string | null>(null);
  const [memoryBotId, setMemoryBotId] = useState<string | null>(null);
  const [toolsBotId, setToolsBotId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;

  const visibleBots = useMemo(() => filterRosterBots(bots, query), [bots, query]);
  const visibleGroups = useMemo(() => filterRosterGroups(groups, bots, query), [groups, bots, query]);

  const pinnedBots = useMemo(
    () => visibleBots.filter((bot) => bot.pinned).sort(byRecency),
    [visibleBots],
  );
  const assignedIds = useMemo(
    () => new Set(sections.flatMap((section) => section.childIds)),
    [sections],
  );
  const unassignedBots = useMemo(
    () =>
      visibleBots
        .filter((bot) => !bot.pinned && !assignedIds.has(bot.id))
        .sort(byRecency),
    [visibleBots, assignedIds],
  );
  const unassignedGroups = useMemo(
    () => visibleGroups.filter((group) => !assignedIds.has(group.id)),
    [visibleGroups, assignedIds],
  );

  const sectionChildren = (section: RosterSection) =>
    section.childIds
      .map((childId) => {
        const bot = visibleBots.find((candidate) => candidate.id === childId);
        if (bot !== undefined) return { kind: "bot" as const, bot };
        const group = visibleGroups.find((candidate) => candidate.id === childId);
        return group !== undefined ? { kind: "group" as const, group } : null;
      })
      .filter((child) => child !== null);

  const openMenu = (target: MenuTarget) => (position: { x: number; y: number }) =>
    setMenu({ ...position, target });

  const menuSectionId =
    menu !== null && (menu.target.kind === "bot" || menu.target.kind === "group")
      ? sections.find((section) => section.childIds.includes(menu.target.id))?.id ?? null
      : null;

  const handleNewSection = () => {
    const name = window.prompt("Section name");
    if (name !== null && name.trim().length > 0) api.addSection(name.trim());
  };

  const select = (id: string | null) => {
    setSelectedId(id);
    if (id !== null) api.setActive(id);
  };

  const requestDelete = (target: PendingDelete) => setPendingDelete(target);

  const confirmDelete = () => {
    if (pendingDelete === null) return;
    if (pendingDelete.kind === "bot") api.deleteBot(pendingDelete.id);
    else if (pendingDelete.kind === "group") api.deleteGroup(pendingDelete.id);
    else api.deleteSection(pendingDelete.id);
    if (selectedId === pendingDelete.id) setSelectedId(null);
    setPendingDelete(null);
  };

  // Flat keyboard order: pinned, then each section's children, then unassigned.
  const flatIds = useMemo(() => {
    if (searching) {
      return [...visibleGroups.map((group) => group.id), ...visibleBots.map((bot) => bot.id)];
    }
    const ids: string[] = [...pinnedBots.map((bot) => bot.id)];
    for (const section of sections) {
      for (const child of sectionChildren(section)) {
        ids.push(child.kind === "bot" ? child.bot.id : child.group.id);
      }
    }
    ids.push(...unassignedGroups.map((group) => group.id));
    ids.push(...unassignedBots.map((bot) => bot.id));
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, visibleBots, visibleGroups, pinnedBots, sections, unassignedBots, unassignedGroups]);

  const effectiveSelected = selectedId !== null && flatIds.includes(selectedId) ? selectedId : null;

  // Keyboard shortcuts: cmd/ctrl+k focuses search; j/k or arrows move the
  // selection; Enter opens; n opens new-bot; e toggles the rail; p pins the
  // selected bot; Delete asks for delete confirmation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement || target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (inField) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const move = (delta: number) => {
        event.preventDefault();
        if (flatIds.length === 0) return;
        const current = effectiveSelected !== null ? flatIds.indexOf(effectiveSelected) : -1;
        const next = current < 0
          ? (delta > 0 ? 0 : flatIds.length - 1)
          : Math.min(flatIds.length - 1, Math.max(0, current + delta));
        const id = flatIds[next];
        if (id !== undefined) {
          setSelectedId(id);
          requestAnimationFrame(() => {
            document.querySelector(`[data-testid="roster-row-${CSS.escape(id)}"]`)
              ?.scrollIntoView({ block: "nearest" });
          });
        }
      };

      switch (event.key) {
        case "j":
        case "ArrowDown":
          move(1);
          break;
        case "k":
        case "ArrowUp":
          move(-1);
          break;
        case "Enter":
          if (effectiveSelected !== null) {
            event.preventDefault();
            api.setActive(effectiveSelected);
          }
          break;
        case "n":
          event.preventDefault();
          setNewBotOpen(true);
          break;
        case "e":
          event.preventDefault();
          api.toggleRail();
          break;
        case "p": {
          event.preventDefault();
          const bot = effectiveSelected !== null ? bots.find((candidate) => candidate.id === effectiveSelected) : undefined;
          if (bot !== undefined) {
            api.setItemPinned(bot.id, !bot.pinned);
            setSelectedId(bot.id);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          if (effectiveSelected === null) break;
          const bot = bots.find((candidate) => candidate.id === effectiveSelected);
          if (bot !== undefined) {
            event.preventDefault();
            requestDelete({ kind: "bot", id: bot.id, label: bot.name });
            break;
          }
          const group = groups.find((candidate) => candidate.id === effectiveSelected);
          if (group !== undefined) {
            event.preventDefault();
            requestDelete({ kind: "group", id: group.id, label: group.name });
            break;
          }
          const section = sections.find((candidate) => candidate.id === effectiveSelected);
          if (section !== undefined) {
            event.preventDefault();
            requestDelete({ kind: "section", id: section.id, label: section.name });
          }
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flatIds, effectiveSelected, bots, groups, sections, api]);

  // Drag and drop: rows are HTML5-draggable; hovering the top/bottom half of
  // a row picks before/after; dropping on a section appends to it, dropping
  // on the unassigned tail clears the section. All persisted via reorderItem.
  const sectionOf = (id: string): string | null =>
    sections.find((section) => section.childIds.includes(id))?.id ?? null;

  const handleDragStart = (id: string) => (event: DragEvent) => {
    setDragId(id);
    setDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", id);
    } catch {
      // Some browsers restrict dataTransfer access to the drop handler.
    }
  };

  const handleDragOverRow = (id: string) => (event: DragEvent) => {
    if (dragId === null || dragId === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    setDropTarget((prev) => (prev !== null && prev.id === id && prev.before === before ? prev : { id, before }));
  };

  const handleDropOnRow = (id: string) => (event: DragEvent) => {
    if (dragId === null || dragId === id) return;
    event.preventDefault();
    event.stopPropagation();
    const before = dropTarget?.id === id ? dropTarget.before : true;
    const targetSection = sectionOf(id);
    setDragId(null);
    setDropTarget(null);
    if (before) {
      api.reorderItem(dragId, id, targetSection);
    } else {
      // Insert after: drop before the row that follows the target in the
      // flat order, falling back to appending within the target's section.
      const at = flatIds.indexOf(id);
      const next = at >= 0 ? flatIds[at + 1] : undefined;
      if (next === undefined) {
        api.reorderItem(dragId, null, targetSection);
      } else {
        api.reorderItem(dragId, next, sectionOf(next) ?? targetSection);
      }
    }
    setSelectedId(dragId);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };

  const handleDropOnSection = (sectionId: string | null) => (event: DragEvent) => {
    if (dragId === null) return;
    event.preventDefault();
    event.stopPropagation();
    const id = dragId;
    setDragId(null);
    setDropTarget(null);
    api.reorderItem(id, null, sectionId);
    setSelectedId(id);
  };

  const indicatorFor = (id: string): "before" | "after" | null =>
    dropTarget !== null && dropTarget.id === id ? (dropTarget.before ? "before" : "after") : null;

  const renderBotRow = (bot: RosterBot) => (
    <ReorderRow
      key={bot.id}
      id={bot.id}
      draggable={!searching}
      indicator={indicatorFor(bot.id)}
      onDragStart={handleDragStart}
      onDragOver={handleDragOverRow}
      onDrop={handleDropOnRow}
      onDragEnd={handleDragEnd}
    >
      <BotRow
        bot={bot}
        isActive={activeId === bot.id}
        selected={effectiveSelected === bot.id}
        onSelect={() => select(bot.id)}
        onMenu={openMenu({ kind: "bot", id: bot.id, pinned: bot.pinned })}
      />
    </ReorderRow>
  );

  const renderGroupRow = (group: RosterGroup) => (
    <ReorderRow
      key={group.id}
      id={group.id}
      draggable={!searching}
      indicator={indicatorFor(group.id)}
      onDragStart={handleDragStart}
      onDragOver={handleDragOverRow}
      onDrop={handleDropOnRow}
      onDragEnd={handleDragEnd}
    >
      <GroupRow
        group={group}
        bots={bots}
        isActive={activeId === group.id}
        selected={effectiveSelected === group.id}
        onSelect={() => select(group.id)}
        onMenu={openMenu({ kind: "group", id: group.id })}
      />
    </ReorderRow>
  );

  const detailsBot = detailsBotId !== null ? bots.find((bot) => bot.id === detailsBotId) ?? null : null;
  const channelsBot = channelsBotId !== null ? bots.find((bot) => bot.id === channelsBotId) ?? null : null;
  const memoryBot = memoryBotId !== null ? bots.find((bot) => bot.id === memoryBotId) ?? null : null;
  const toolsBot = toolsBotId !== null ? bots.find((bot) => bot.id === toolsBotId) ?? null : null;

  // Icon rail: avatar-only column with a create button above the footer.
  if (railCollapsed) {
    return (
      <aside
        data-testid="roster-sidebar"
        data-collapsed="true"
        className="flex h-dvh w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2"
      >
        <button
          type="button"
          aria-label="Expand sidebar"
          data-testid="rail-toggle"
          onClick={api.toggleRail}
          className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeftIcon className="size-4" />
        </button>
        <div className="mt-auto flex flex-col items-center gap-1 pb-1">
          {pinnedBots.length > 0 ? <span className="mb-1 size-1 rounded-full bg-sidebar-muted-foreground" /> : null}
          {[...pinnedBots, ...visibleBots.filter((bot) => !bot.pinned)].map((bot) => (
            <button
              key={bot.id}
              type="button"
              aria-label={bot.name}
              title={bot.name}
              data-testid={`roster-row-${bot.id}`}
              aria-current={activeId === bot.id || undefined}
              onClick={() => api.setActive(bot.id)}
              className={cn(
                "flex size-9 cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeId === bot.id ? "bg-white/[0.08]" : "hover:bg-accent",
              )}
            >
              <BotAvatar identity={bot.bloub} size={28} />
            </button>
          ))}
          {unassignedGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-label={group.name}
              title={group.name}
              data-testid={`roster-row-${group.id}`}
              aria-current={activeId === group.id || undefined}
              onClick={() => api.setActive(group.id)}
              className={cn(
                "flex size-9 cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeId === group.id ? "bg-white/[0.08]" : "hover:bg-accent",
              )}
            >
              <GroupMemberStack group={group} bots={bots} sizeClassName="size-5" />
            </button>
          ))}
        </div>
        <UserProfileFooter collapsed />
      </aside>
    );
  }

  return (
    <aside
      data-testid="roster-sidebar"
      data-collapsed="false"
      className="flex h-dvh w-[300px] shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground"
    >
      <header className="flex shrink-0 items-center gap-1.5 px-3 py-3">
        <button
          type="button"
          aria-label="Collapse sidebar"
          data-testid="rail-toggle"
          onClick={api.toggleRail}
          className="flex size-8 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PanelLeftIcon className="size-4" />
        </button>
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-accent px-2.5 ring-ring focus-within:ring-2">
          <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            data-testid="roster-search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query.length > 0) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
          />
        </label>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="Create"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            data-testid="new-bot-button"
            onClick={() => setPlusOpen((open) => !open)}
            className="flex size-8 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PlusIcon className="size-4" />
          </button>
          {plusOpen ? (
            <div
              className="fixed inset-0 z-40"
              onClick={() => setPlusOpen(false)}
              onContextMenu={(event) => {
                event.preventDefault();
                setPlusOpen(false);
              }}
            >
              <div
                role="menu"
                data-testid="roster-create-menu"
                onClick={(event) => event.stopPropagation()}
                className="absolute right-0 top-9 z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-float)]"
              >
                <button type="button" role="menuitem" data-testid="new-bot-menu-item" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent" onClick={() => { setPlusOpen(false); setNewBotOpen(true); }}>
                  <BotIcon className="size-3.5" />
                  New bot
                </button>
                <button type="button" role="menuitem" data-testid="new-group-menu-item" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent" onClick={() => { setPlusOpen(false); setNewGroupOpen(true); }}>
                  <UsersIcon className="size-3.5" />
                  New group
                </button>
                <button type="button" role="menuitem" data-testid="new-section-menu-item" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent" onClick={() => { setPlusOpen(false); handleNewSection(); }}>
                  <FolderIcon className="size-3.5" />
                  New section
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </header>

      <nav className="min-h-0 flex-1 overflow-y-auto pb-2" aria-label="Bots and groups">
        {searching ? (
          <>
            {visibleGroups.map((group) => renderGroupRow(group))}
            {visibleBots.map((bot) => renderBotRow(bot))}
            {visibleBots.length === 0 && visibleGroups.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">No bots match</div>
            ) : null}
          </>
        ) : (
          <>
            {pinnedBots.length > 0 ? (
              <div className="mb-1">
                <div className="mx-2 flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-sidebar-muted-foreground">
                  <PinIcon className="size-3.5" />
                  <span>Pinned</span>
                  <span className="tabular-nums">{pinnedBots.length}</span>
                </div>
                {pinnedBots.map((bot) => renderBotRow(bot))}
              </div>
            ) : null}

            {sections.map((section) => {
              const collapsed = api.isSectionCollapsed(section.id);
              const children = sectionChildren(section);
              return (
                <div
                  key={section.id}
                  className="mb-1"
                  onDragOver={dragId !== null ? (event) => { event.preventDefault(); } : undefined}
                  onDrop={dragId !== null ? handleDropOnSection(section.id) : undefined}
                >
                  <SectionHeader
                    name={section.name}
                    count={children.length}
                    collapsed={collapsed}
                    onToggle={() => api.toggleSectionCollapsed(section.id)}
                    onMenu={openMenu({ kind: "section", id: section.id })}
                  />
                  {!collapsed
                    ? children.map((child) =>
                        child.kind === "bot" ? (
                          renderBotRow(child.bot)
                        ) : (
                          renderGroupRow(child.group)
                        ),
                      )
                    : null}
                </div>
              );
            })}

            {unassignedGroups.length > 0 ? (
              <div className="mb-1">
                {sections.length > 0 ? (
                  <div className="mx-2 flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-sidebar-muted-foreground">
                    <span>Unassigned</span>
                    <span className="tabular-nums">{unassignedBots.length + unassignedGroups.length}</span>
                  </div>
                ) : null}
                {unassignedGroups.map((group) => renderGroupRow(group))}
              </div>
            ) : null}

            {unassignedBots.map((bot) => renderBotRow(bot))}

            {dragId !== null ? (
              <div
                data-testid="roster-drop-unassigned"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDropOnSection(null)}
                className="mx-2 rounded-md border border-dashed border-border px-3 py-2 text-center text-xs text-sidebar-muted-foreground"
              >
                Drop here to unassign
              </div>
            ) : null}

            {visibleBots.length === 0 && visibleGroups.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">No bots yet</div>
            ) : null}
          </>
        )}
      </nav>

      <UserProfileFooter />

      {menu !== null ? (
        <ContextMenu
          menu={menu}
          sections={sections}
          childSectionId={menuSectionId}
          onPin={(pinned) => {
            if (menu.target.kind === "bot") api.setItemPinned(menu.target.id, pinned);
          }}
          onMove={(sectionId) => {
            if (menu.target.kind === "bot") api.moveItem(menu.target.id, sectionId);
            else if (menu.target.kind === "group") api.moveItem(menu.target.id, sectionId);
          }}
          onDelete={() => {
            if (menu === null) return;
            if (menu.target.kind === "bot") {
              const bot = bots.find((candidate) => candidate.id === menu.target.id);
              requestDelete({ kind: "bot", id: menu.target.id, label: bot?.name ?? "bot" });
            } else if (menu.target.kind === "group") {
              const group = groups.find((candidate) => candidate.id === menu.target.id);
              requestDelete({ kind: "group", id: menu.target.id, label: group?.name ?? "group" });
            } else {
              const section = sections.find((candidate) => candidate.id === menu.target.id);
              requestDelete({ kind: "section", id: menu.target.id, label: section?.name ?? "section" });
            }
          }}
          onDetails={() => {
            if (menu.target.kind === "bot") {
              setDetailsBotId(menu.target.id);
              setSelectedId(menu.target.id);
            }
          }}
          onChannels={() => {
            if (menu.target.kind === "bot") {
              setChannelsBotId(menu.target.id);
              setSelectedId(menu.target.id);
            }
          }}
          onMemory={() => {
            if (menu.target.kind === "bot") {
              setMemoryBotId(menu.target.id);
              setSelectedId(menu.target.id);
            }
          }}
          onTools={() => {
            if (menu.target.kind === "bot") {
              setToolsBotId(menu.target.id);
              setSelectedId(menu.target.id);
            }
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <NewBotDialog
        open={newBotOpen}
        onOpenChange={setNewBotOpen}
        onCreate={({ name, identity, persona, instructions, modelId, avatarVariant, avatarImage, identiconStyle }) => {
          api.addBot(name, identity, {
            persona,
            instructions,
            modelId,
            avatarVariant,
            avatarImage,
            identiconStyle,
          });
          setNewBotOpen(false);
        }}
      />
      <NewGroupDialog
        open={newGroupOpen}
        bots={bots}
        onOpenChange={setNewGroupOpen}
        onCreate={({ name, memberIds }) => {
          api.addGroup(name, memberIds);
          setNewGroupOpen(false);
        }}
      />
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        label={pendingDelete?.label ?? "item"}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={confirmDelete}
      />
      <BotDetailsPanel
        bot={detailsBot}
        open={detailsBotId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsBotId(null);
        }}
        onUpdate={api.updateBot}
      />
      <BotChannelsSheet
        bot={channelsBot}
        open={channelsBotId !== null}
        onOpenChange={(open) => {
          if (!open) setChannelsBotId(null);
        }}
        onUpdate={api.updateBot}
      />
      <BotMemorySheet
        bot={memoryBot}
        open={memoryBotId !== null}
        onOpenChange={(open) => {
          if (!open) setMemoryBotId(null);
        }}
        onUpdate={api.updateBot}
      />
      <BotToolsSheet
        bot={toolsBot}
        open={toolsBotId !== null}
        onOpenChange={(open) => {
          if (!open) setToolsBotId(null);
        }}
        onUpdate={api.updateBot}
      />
    </aside>
  );
}

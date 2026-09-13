// Roster sidebar, ported from akeru's BotRosterSidebar.tsx (MIT) and stripped
// of its Effect/atom store, router, drag-and-drop, and base-ui menu layers:
// plain React state + Tailwind utilities against the lib/roster.ts contract.
// Kept from akeru: iMessage-style rows (avatar, name, relative timestamp,
// one-line preview, presence, unread badge), pinned area, collapsible
// sections, search filtering, icon rail, and the create menu.
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
import { useEffect, useMemo, useState } from "react";
import type { RosterBot, RosterGroup, RosterSection } from "../../lib/roster";
import BotAvatar from "./BotAvatar";
import { GroupMemberStack } from "./GroupMemberStack";
import { NewBotDialog } from "./NewBotDialog";
import { NewGroupDialog } from "./NewGroupDialog";
import { cn, filterRosterBots, filterRosterGroups, formatRosterTimestamp, groupMembers } from "./roster.logic";
import type { RosterApi } from "./useRosterState";

type MenuTarget =
  | { kind: "bot"; id: string; pinned: boolean }
  | { kind: "group"; id: string }
  | { kind: "section"; id: string };

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
  onSelect,
  onMenu,
}: {
  bot: RosterBot;
  isActive: boolean;
  onSelect: () => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const sleeping = bot.presence === "sleeping";
  const typing = bot.presence === "typing";
  return (
    <div
      className="mx-2"
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
          "flex h-[60px] w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive
            ? "bg-white/[0.08] text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-accent",
          sleeping && "opacity-60",
        )}
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center">
          {/* Sleeping blobs collapse to a dot in the bloub engine; render the
              idle body dimmed so the roster never reads as broken. */}
          <BotAvatar identity={bot.bloub} presence={sleeping ? "idle" : bot.presence} size={40} />
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
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
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
  onSelect,
  onMenu,
}: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  isActive: boolean;
  onSelect: () => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  const members = groupMembers(group, bots);
  return (
    <div
      className="mx-2"
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
          "flex h-[60px] w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive
            ? "bg-white/[0.08] text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-accent",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center">
          <GroupMemberStack group={group} bots={bots} sizeClassName="size-9" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
            {group.name}
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
  onClose,
}: {
  menu: { x: number; y: number; target: MenuTarget };
  sections: readonly RosterSection[];
  childSectionId: string | null;
  onPin: (pinned: boolean) => void;
  onMove: (sectionId: string | null) => void;
  onDelete: () => void;
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
            {visibleGroups.map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                bots={bots}
                isActive={activeId === group.id}
                onSelect={() => api.setActive(group.id)}
                onMenu={openMenu({ kind: "group", id: group.id })}
              />
            ))}
            {visibleBots.map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                isActive={activeId === bot.id}
                onSelect={() => api.setActive(bot.id)}
                onMenu={openMenu({ kind: "bot", id: bot.id, pinned: bot.pinned })}
              />
            ))}
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
                {pinnedBots.map((bot) => (
                  <BotRow
                    key={bot.id}
                    bot={bot}
                    isActive={activeId === bot.id}
                    onSelect={() => api.setActive(bot.id)}
                    onMenu={openMenu({ kind: "bot", id: bot.id, pinned: bot.pinned })}
                  />
                ))}
              </div>
            ) : null}

            {sections.map((section) => {
              const collapsed = api.isSectionCollapsed(section.id);
              const children = sectionChildren(section);
              return (
                <div key={section.id} className="mb-1">
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
                          <BotRow
                            key={child.bot.id}
                            bot={child.bot}
                            isActive={activeId === child.bot.id}
                            onSelect={() => api.setActive(child.bot.id)}
                            onMenu={openMenu({ kind: "bot", id: child.bot.id, pinned: child.bot.pinned })}
                          />
                        ) : (
                          <GroupRow
                            key={child.group.id}
                            group={child.group}
                            bots={bots}
                            isActive={activeId === child.group.id}
                            onSelect={() => api.setActive(child.group.id)}
                            onMenu={openMenu({ kind: "group", id: child.group.id })}
                          />
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
                {unassignedGroups.map((group) => (
                  <GroupRow
                    key={group.id}
                    group={group}
                    bots={bots}
                    isActive={activeId === group.id}
                    onSelect={() => api.setActive(group.id)}
                    onMenu={openMenu({ kind: "group", id: group.id })}
                  />
                ))}
              </div>
            ) : null}

            {unassignedBots.map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                isActive={activeId === bot.id}
                onSelect={() => api.setActive(bot.id)}
                onMenu={openMenu({ kind: "bot", id: bot.id, pinned: bot.pinned })}
              />
            ))}

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
            if (menu.target.kind === "bot") api.deleteBot(menu.target.id);
            else if (menu.target.kind === "group") api.deleteGroup(menu.target.id);
            else api.deleteSection(menu.target.id);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <NewBotDialog
        open={newBotOpen}
        onOpenChange={setNewBotOpen}
        onCreate={({ name, identity }) => {
          api.addBot(name, identity);
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
    </aside>
  );
}

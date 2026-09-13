// Roster presentation helpers, ported from
// refs/akeru-bot/apps/web/src/components/roster/roster.logic.ts (MIT) and
// reduced to what the pi-do sidebar needs: search filtering and the
// iMessage-style relative timestamp. Akeru's Effect/atom dependencies are
// stripped; timestamps take epoch ms (RosterBot.updatedAt) instead of ISO.
import type { RosterBot, RosterGroup } from "../../lib/roster";

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const numericDateFormatter = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const numericDateWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });


/** Classnames joiner (akeru's lib/utils cn, reduced to the used subset). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
/**
 * Compact roster timestamp, iMessage-style: today shows the clock time,
 * yesterday "Yesterday", the rest of the past week its weekday, older dates
 * the numeric date (with the year once the calendar year differs).
 */
export function formatRosterTimestamp(epochMs: number, nowMs: number = Date.now()): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return timeFormatter.format(date);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return weekdayFormatter.format(date);
  return date.getFullYear() === now.getFullYear()
    ? numericDateFormatter.format(date)
    : numericDateWithYearFormatter.format(date);
}

function botMatchesQuery(bot: RosterBot, needle: string): boolean {
  return bot.name.toLowerCase().includes(needle) || bot.preview.toLowerCase().includes(needle);
}

/** Bots matching the search needle by name or preview; order preserved. */
export function filterRosterBots(bots: readonly RosterBot[], query: string): RosterBot[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...bots];
  return bots.filter((bot) => botMatchesQuery(bot, needle));
}

/**
 * Groups visible under the search needle: a group matches when its own name
 * matches or any of its member bots matches.
 */
export function filterRosterGroups(
  groups: readonly RosterGroup[],
  bots: readonly RosterBot[],
  query: string,
): RosterGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...groups];
  return groups.filter((group) => {
    if (group.name.toLowerCase().includes(needle)) return true;
    return group.memberIds.some((memberId) => {
      const member = bots.find((bot) => bot.id === memberId);
      return member ? botMatchesQuery(member, needle) : false;
    });
  });
}

/** Member bots of a group, in memberIds order; unknown ids dropped. */
export function groupMembers(group: RosterGroup, bots: readonly RosterBot[]): RosterBot[] {
  return group.memberIds
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot) => bot !== undefined);
}

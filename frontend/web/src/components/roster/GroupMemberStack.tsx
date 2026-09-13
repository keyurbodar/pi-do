// Overlapping member avatars for group rows, ported from akeru's
// GroupMemberStack.tsx (MIT) with BotAvatarView swapped for the placeholder.
import type { RosterBot, RosterGroup } from "../../lib/roster";
import { BotAvatarPlaceholder } from "./BotAvatarPlaceholder";
import { cn, groupMembers } from "./roster.logic";

export function GroupMemberStack({
  group,
  bots,
  sizeClassName = "size-6",
  className,
}: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  sizeClassName?: string;
  className?: string;
}) {
  const members = groupMembers(group, bots);
  return (
    <div className={cn("relative inline-flex shrink-0", sizeClassName, className)}>
      {members.slice(0, 2).map((bot, index) => (
        <BotAvatarPlaceholder
          key={bot.id}
          identity={bot.bloub}
          name={bot.name}
          className={cn(
            "absolute size-[68%]",
            index === 0 ? "left-0 top-0" : "bottom-0 right-0 z-10",
          )}
        />
      ))}
    </div>
  );
}

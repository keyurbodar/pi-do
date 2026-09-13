// Placeholder avatar until wt-avatar's real Bloub renderer lands: a colored
// circle keyed off the bot identity. The import site (BotAvatarPlaceholder)
// is the swap point — nothing else needs to change at merge time.
import type { BloubIdentity } from "../../lib/roster";
import { colorHex } from "./identity";
import { cn } from "./roster.logic";

export function BotAvatarPlaceholder({
  identity,
  name,
  className,
}: {
  identity: BloubIdentity;
  name: string;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ backgroundColor: colorHex(identity.color) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full ring-1 ring-white/10", className)}
    />
  );
}

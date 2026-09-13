// components/chat/ActivityRow.tsx — akeru BotActivityStatus markup (MIT):
// avatar slot + shimmer label shown while the last turn is streaming on an
// open connection. The shell injects the avatar; the shimmer reuses the
// existing aicss atom.
import type { ReactNode } from "react";

import { Shimmer } from "../aicss";

export function ActivityRow({ avatarSlot = null }: { avatarSlot?: ReactNode }) {
  return (
    <div
      aria-live="polite"
      data-testid="activity-row"
      className="flex min-h-8 items-center gap-3 px-2 py-1 text-sm"
    >
      {avatarSlot !== null && <div className="flex size-8 shrink-0 items-center justify-center">{avatarSlot}</div>}
      <Shimmer>Receiving context…</Shimmer>
    </div>
  );
}

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
      className="flex items-center gap-2.5 px-1 py-0.5 text-sm"
    >
      {avatarSlot !== null && <div className="shrink-0">{avatarSlot}</div>}
      <Shimmer>Receiving context…</Shimmer>
    </div>
  );
}

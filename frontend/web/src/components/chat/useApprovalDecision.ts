// components/chat/useApprovalDecision.ts — local decision state machine
// for fixture approval cards. No backend: deciding flips pending →
// approved/rejected locally, appends the decided marker, and lets the
// scripted playback continue underneath.
import { useState } from "react";

import type { ApprovalVM } from "../thread/viewModel";

export type ApprovalDecision = ApprovalVM["state"];

export function useApprovalDecision(
  initial: ApprovalDecision = "pending",
  onDecide?: (decision: Exclude<ApprovalDecision, "pending">) => void,
): {
  state: ApprovalDecision;
  decided: boolean;
  decide: (decision: Exclude<ApprovalDecision, "pending">) => void;
} {
  const [state, setState] = useState<ApprovalDecision>(initial);
  return {
    state,
    decided: state !== "pending",
    decide: (decision) => {
      setState((prev) => {
        if (prev !== "pending") return prev;
        return decision;
      });
      onDecide?.(decision);
    },
  };
}

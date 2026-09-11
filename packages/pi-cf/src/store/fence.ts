// fence.ts — shared owner-fence + revision CAS. Both the one-shot /run and
// /claim paths and the WS stream path enforce through here; no copies.
export interface FenceState {
  fence: string | null;
  revision: number;
}

export type FenceCheck =
  | { fence: string; revision: number }
  | { status: 403 | 409; body: { error: string; hint: string; revision: number; fence: string | null } };

export function enforceFence(
  cur: FenceState | null,
  fence: unknown,
  expected: unknown,
): FenceCheck {
  if (cur === null || cur.fence === null || cur.fence !== fence) {
    return {
      status: 403,
      body: {
        error: "fence mismatch",
        hint: "Fenced: stale holder; claim with the live fence or mint a fresh session",
        revision: cur?.revision ?? 0,
        fence: cur?.fence ?? null,
      },
    };
  }
  if (cur.revision !== expected) {
    return {
      status: 409,
      body: {
        error: "revision conflict",
        hint: `Conflict: expected revision ${String(expected)} but current revision is ${cur.revision}; re-read and retry with expected ${cur.revision}`,
        revision: cur.revision,
        fence: cur.fence,
      },
    };
  }
  return { fence: crypto.randomUUID(), revision: cur.revision + 1 };
}

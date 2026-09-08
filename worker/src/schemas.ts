import * as v from "valibot";
import { vValidator } from "@hono/valibot-validator";

export const execSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
  cwd: v.optional(v.string()),
  env: v.optional(v.unknown()),
  sid: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export const sidSchema = v.object({
  sid: v.pipe(v.string(), v.minLength(1)),
});

export const bgSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
  cwd: v.optional(v.string()),
  env: v.optional(v.unknown()),
});

export const handleSchema = v.object({
  handle: v.pipe(v.string(), v.minLength(1)),
});

export type ValidatorRoute = "exec" | "execKill" | "execDispose" | "bg" | "bgKill";

export interface ValidatorSpec {
  error: string;
  hint: string;
}

const badCwd: ValidatorSpec = {
  error: "bad cwd",
  hint: 'cwd must be a string path, e.g. {"command": "pwd", "cwd": "/workspace"}',
};

export const hintFor: Record<ValidatorRoute, Record<string, ValidatorSpec>> = {
  exec: {
    cwd: badCwd,
    sid: {
      error: "bad sid",
      hint: 'sid must be a session id string, e.g. {"command": "echo hi", "sid": "exec-1"}',
    },
    default: {
      error: "missing command",
      hint: 'retry as POST /workspaces/:id/exec with JSON {"command": "echo hi"}',
    },
  },
  execKill: {
    default: {
      error: "missing sid",
      hint: 'retry as POST /workspaces/:id/exec/kill with JSON {"sid": "exec-1"}',
    },
  },
  execDispose: {
    default: {
      error: "missing sid",
      hint: 'retry as POST /workspaces/:id/exec/dispose with JSON {"sid": "exec-1"}',
    },
  },
  bg: {
    cwd: badCwd,
    default: {
      error: "missing command",
      hint: 'retry as POST /workspaces/:id/bg with JSON {"command": "sleep 30"}',
    },
  },
  bgKill: {
    default: {
      error: "missing handle",
      hint: 'retry as POST /workspaces/:id/bg/kill with JSON {"handle": "bg-..."}',
    },
  },
};

function issueKey(result: { issues?: Array<{ path?: Array<{ key?: unknown }> | null }> }): string | null {
  const path = result.issues?.[0]?.path;
  if (!path) return null;
  for (const segment of path) {
    if (segment && typeof segment.key === "string") return segment.key;
  }
  return null;
}

export function vRoute<T extends v.GenericSchema | v.GenericSchemaAsync>(route: ValidatorRoute, schema: T) {
  return vValidator("json", schema, (result, c) => {
    if (!result.success) {
      const table = hintFor[route];
      const key = issueKey(result);
      const spec = (key !== null ? table[key] : undefined) ?? table.default;
      return c.json(spec, 400);
    }
    return undefined;
  });
}

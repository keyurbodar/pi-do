import * as v from "valibot";

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

export const claimSchema = v.object({
  fence: v.pipe(v.string(), v.minLength(1)),
  expected: v.pipe(v.number(), v.integer()),
});

export const modelSchema = v.object({
  provider: v.optional(v.pipe(v.string(), v.minLength(1))),
  id: v.optional(v.pipe(v.string(), v.minLength(1))),
  fence: v.optional(v.pipe(v.string(), v.minLength(1))),
  expected: v.optional(v.pipe(v.number(), v.integer())),
});

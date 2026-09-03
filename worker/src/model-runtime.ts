// Pattern source (read-only): refs/pi/packages/ai src/types.ts Model
// (id/name/api/provider/baseUrl plus a stream function) and
// refs/pi/packages/coding-agent ModelRuntime.create (async model/auth
// facade). Here the runtime is sync and key-driven: provider keys are read
// from env, otherwise the deterministic stub stands in. Never log keys:
// key material only decides the branch and never leaves memory.
export const STUB_MODEL_ID = "stub";

export interface RuntimeModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
}

export interface ModelRuntime {
  model: RuntimeModel;
  stub: boolean;
}

export interface RuntimeEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MODEL_ID?: string;
}

export function buildRuntime(env: RuntimeEnv): ModelRuntime {
  const override =
    typeof env.MODEL_ID === "string" && env.MODEL_ID.length > 0
      ? env.MODEL_ID
      : undefined;
  if (
    typeof env.ANTHROPIC_API_KEY === "string" &&
    env.ANTHROPIC_API_KEY.length > 0
  ) {
    const id = override ?? "claude-sonnet-4-5";
    return {
      model: {
        id,
        name: id,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      },
      stub: false,
    };
  }
  if (
    typeof env.OPENAI_API_KEY === "string" &&
    env.OPENAI_API_KEY.length > 0
  ) {
    const id = override ?? "gpt-4o";
    return {
      model: {
        id,
        name: id,
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com",
      },
      stub: false,
    };
  }
  // DEV-ONLY fallback: no provider keys in env, so the keyless stub stands
  // in. Production callers must supply keys; this branch exists for local
  // verify without credentials.
  return {
    model: {
      id: STUB_MODEL_ID,
      name: STUB_MODEL_ID,
      api: "stub",
      provider: "stub",
      baseUrl: "",
    },
    stub: true,
  };
}

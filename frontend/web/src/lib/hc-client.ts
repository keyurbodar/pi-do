import { hc } from "hono/client";
import type { AppType } from "../../../../worker/src/index";

declare global {
  interface ImportMetaEnv {
    PUBLIC_WORKER_URL?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
export function workerBaseUrl(): string {
  const fromEnv = import.meta.env.PUBLIC_WORKER_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv.replace(/\/+$/, "");
  return "http://127.0.0.1:8787";
}
export const api = hc<AppType>(workerBaseUrl());


/**
 * Typed fetch seam over PI_DO_URL. Sends fence headers; the hono `hc`
 * typed client plugs in next phase without changing call sites.
 */

import type { FenceState } from './pi-do-ws';

interface PiDoEnv {
  PI_DO_URL?: string;
}

function readEnv(): PiDoEnv {
  const meta = import.meta as unknown as { env?: PiDoEnv };
  return meta.env ?? {};
}

export const PI_DO_URL: string =
  readEnv().PI_DO_URL ?? 'http://localhost:8787';

export function fenceHeaders(fence: FenceState | null): HeadersInit {
  if (!fence) return {};
  return {
    'x-pi-do-fence': fence.fence,
    'x-pi-do-revision': String(fence.revision),
  };
}

function shell(): never {
  throw new Error('hc-client: shell only, hono hc plugs in next phase');
}

export async function api<T>(
  _path: string,
  _init?: RequestInit,
): Promise<T> {
  shell();
}

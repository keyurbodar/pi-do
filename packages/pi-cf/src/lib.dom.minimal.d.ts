interface Console {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}
declare var console: Console;
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;
declare function clearTimeout(handle: number): void;
declare function setInterval(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;
declare function clearInterval(handle: number): void;
declare function queueMicrotask(callback: () => void): void;
declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
interface RequestInit {
  method?: string;
  headers?: Headers | Record<string, string> | string[][];
  body?: unknown;
  signal?: AbortSignal | null;
}
declare class Headers {
  constructor(init?: Headers | Record<string, string> | string[][]);
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  append(name: string, value: string): void;
  forEach(callback: (value: string, key: string) => void): void;
}
declare class Request {
  constructor(input: string | URL | Request, init?: RequestInit);
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
declare class Response {
  constructor(body?: unknown, init?: { status?: number; headers?: Headers | Record<string, string> });
  readonly status: number;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  static json(data: unknown, init?: { status?: number }): Response;
}
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
  toString(): string;
}
declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | string[][]);
  get(name: string): string | null;
  set(name: string, value: string): void;
  toString(): string;
}
interface TextEncodeOptions {
  stream?: boolean;
}
interface TextDecodeOptions {
  stream?: boolean;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
declare class TextDecoder {
  constructor(label?: string, options?: TextDecodeOptions);
  decode(input?: ArrayBuffer | Uint8Array, options?: TextDecodeOptions): string;
}
interface Crypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}
declare var crypto: Crypto;
interface Performance {
  now(): number;
}
declare var performance: Performance;
interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}
declare class Event {
  constructor(type: string, init?: EventInit);
  readonly type: string;
}
declare class EventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
}
declare class AbortSignal extends EventTarget {
  readonly aborted: boolean;
  static timeout(ms: number): AbortSignal;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

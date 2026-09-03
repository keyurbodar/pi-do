// loader.ts — trusted VFS extension loader on pi's jiti trust: no sandbox.
//
// Read-only ref (never import): refs/pi packages/coding-agent
// src/core/extensions/loader.ts. pi loads workspace .pi/extensions files with
// jiti and hands each factory its ExtensionAPI; here the workspace VFS holds
// the files, so each source is evaluated in-harness and the factory gets the
// same InlineExtensionApi registry PR19 built for inline extensions — same
// powers, later binding time.
//
// Host injection is exactly the registry plus the tool context, nothing else:
// each source runs as a function body with (api, context) in scope. No eval
// options beyond that: no timeout, no sandbox, no module loader. Sources stay
// plain JavaScript, so type annotations and import/export statements fail
// closed with a hint instead of pulling a transpiler into the Worker.
import type { FileStoreLike } from "./env.ts";
import type { InlineExtensionApi, InlineExtensionFactory } from "./extensions.ts";
import type { ToolContext } from "./tools.ts";

export const VFS_EXTENSIONS_DIR = ".pi/extensions";

function fail(error: string, hint: string): never {
  throw { error, hint };
}

// Same file gate as pi's isExtensionFile: depth-1 .ts/.js only, sorted so
// turn order stays deterministic across SQLite page layouts. Nested files
// load only through their subdir manifest or index file below, never twice.
export function discoverVfsExtensions(files: FileStoreLike, ws: string): string[] {
  const prefix = `${VFS_EXTENSIONS_DIR}/`;
  const all = files
    .list(ws, prefix)
    .map((entry) => entry.path)
    .sort();
  const found: string[] = [];
  const subdirs = new Set<string>();
  for (const path of all) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      if (rest.endsWith(".ts") || rest.endsWith(".js")) found.push(path);
      continue;
    }
    subdirs.add(rest.slice(0, slash));
  }
  for (const sub of [...subdirs].sort()) found.push(...resolveSubdirEntries(files, ws, sub));
  return found.sort();
}

// pi's resolveExtensionEntries shape, fail-closed: a present package.json
// must parse with a usable pi.extensions list, and every named entry must
// resolve to a .ts/.js file inside the same subdir. No npm install, no
// dependency resolution: the manifest names files, nothing more.
function resolveSubdirEntries(files: FileStoreLike, ws: string, sub: string): string[] {
  const base = `${VFS_EXTENSIONS_DIR}/${sub}`;
  const manifestPath = `${base}/package.json`;
  const raw = files.get(ws, manifestPath);
  if (raw !== undefined) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let pkg: unknown;
    try {
      pkg = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      fail(
        `bad extension manifest: ${base}`,
        "package.json must be JSON with { pi: { extensions: [...] } } naming .ts/.js files in this subdir, or remove it so index.ts loads instead",
      );
    }
    const piField: unknown = pkg !== null && typeof pkg === "object" && "pi" in pkg ? pkg.pi : undefined;
    const exts: unknown =
      piField !== null && typeof piField === "object" && "extensions" in piField ? piField.extensions : undefined;
    if (!Array.isArray(exts) || exts.length === 0 || !exts.every((e) => typeof e === "string")) {
      fail(
        `bad extension manifest: ${base}`,
        "package.json needs { pi: { extensions: [...] } } with at least one .ts/.js path in this subdir, or remove it so index.ts loads instead",
      );
    }
    return exts.map((entry: string) => resolveManifestEntry(files, ws, base, entry));
  }
  for (const name of ["index.ts", "index.js"]) {
    if (files.exists(ws, `${base}/${name}`)) return [`${base}/${name}`];
  }
  return [];
}

// Lexical join: entries stay inside their subdir, so ../ cannot pull a file
// from another extension or the workspace root into this factory's scope.
function resolveManifestEntry(files: FileStoreLike, ws: string, base: string, entry: string): string {
  const parts: string[] = [];
  for (const part of entry.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        fail(`bad extension manifest: ${base}`, `entry ${entry} leaves this subdir; name a .ts/.js file inside it instead`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const resolved = `${base}/${parts.join("/")}`;
  if (!resolved.endsWith(".ts") && !resolved.endsWith(".js")) {
    fail(`bad extension manifest: ${base}`, `entry ${entry} is not a .ts or .js file; name the entry file directly`);
  }
  if (!files.exists(ws, resolved)) {
    fail(`bad extension manifest: ${base}`, `entry ${entry} not found under ${base}; write the file or fix the pi.extensions path`);
  }
  return resolved;
}

type VfsModuleFn = (api: InlineExtensionApi, context: ToolContext) => unknown;

// AsyncFunction, not Function, so await works at the top level of a file.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as unknown as new (
  ...args: string[]
) => VfsModuleFn;

export function compileVfsExtension(
  path: string,
  source: string,
  context: ToolContext,
): InlineExtensionFactory {
  let fn: VfsModuleFn;
  try {
    fn = new AsyncFunction("api", "context", source);
  } catch {
    fail(
      `bad extension file: ${path}`,
      "extension files run as plain JavaScript with (api, context) in scope; remove type annotations and import/export statements, then retry",
    );
  }
  return async (api) => {
    try {
      await fn(api, context);
    } catch (e) {
      if (e !== null && typeof e === "object" && "error" in e) throw e;
      const detail = e instanceof Error && e.message.length > 0 ? `: ${e.message}` : "";
      fail(
        `extension failed: ${path}`,
        `the factory threw${detail}; fix the file or remove it so turns run clean`,
      );
    }
  };
}

// One pass per turn: a file deleted between discover and read is skipped, and
// the next turn discovers again, so removal lands without a new session.
export function loadVfsExtensionFactories(
  files: FileStoreLike,
  ws: string,
  context: ToolContext,
): InlineExtensionFactory[] {
  const decoder = new TextDecoder();
  const factories: InlineExtensionFactory[] = [];
  for (const path of discoverVfsExtensions(files, ws)) {
    const body = files.get(ws, path);
    if (body === undefined) continue;
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    factories.push(compileVfsExtension(path, decoder.decode(bytes), context));
  }
  return factories;
}

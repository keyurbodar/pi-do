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

// Same file gate as pi's isExtensionFile: .ts or .js only, sorted so turn
// order stays deterministic across SQLite page layouts.
export function discoverVfsExtensions(files: FileStoreLike, ws: string): string[] {
  return files
    .list(ws, `${VFS_EXTENSIONS_DIR}/`)
    .map((entry) => entry.path)
    .filter((path) => path.endsWith(".ts") || path.endsWith(".js"))
    .sort();
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

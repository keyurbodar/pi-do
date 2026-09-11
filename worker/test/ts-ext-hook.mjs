// ts-ext-hook.mjs — resolve hook so node --test can load worker sources
// directly: worker .ts files import siblings without an extension, which
// plain node ESM resolution rejects. Maps an extensionless relative import
// to its .ts file when one exists; everything else falls through.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && path.extname(specifier) === "" && context.parentURL.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    throw error;
  }
}

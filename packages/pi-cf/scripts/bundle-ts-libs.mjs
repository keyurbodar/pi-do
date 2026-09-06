import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "..", "package.json"));
const LIBDIR = join(dirname(require.resolve("typescript/package.json")), "lib");
const NAMES = ["lib.es5.d.ts", "lib.es2015.collection.d.ts", "lib.es2015.promise.d.ts"];
const LOCAL = [{ name: "lib.dom.d.ts", file: join(HERE, "..", "src", "lib.dom.minimal.d.ts") }];
const entries = NAMES.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(readFileSync(join(LIBDIR, name), "utf8"))},`)
  .concat(LOCAL.map(({ name, file }) => `  ${JSON.stringify(name)}: ${JSON.stringify(readFileSync(file, "utf8"))},`)).join("\n");
const ALL = NAMES.concat(LOCAL.map(({ name }) => name));
writeFileSync(
  join(HERE, "..", "src", "ts-libs.generated.ts"),
  `export const TS_LIB_FILE_NAMES: string[] = ${JSON.stringify(ALL)};\nexport const TS_LIB_TEXTS: Record<string, string> = {\n${entries}\n};\n`,
);
console.log(`wrote ts-libs.generated.ts (${ALL.length} libs)`);

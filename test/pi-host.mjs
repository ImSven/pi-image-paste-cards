// Locate the host Pi install so tests use the exact runtime the extension targets.
// Order: PI_PACKAGE_DIR, a local devDependency, then the global npm root.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const NAME = "@earendil-works/pi-coding-agent";

function findPi() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    candidates.push(dirname(createRequire(import.meta.url).resolve(`${NAME}/package.json`)));
  } catch {}
  try {
    candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), NAME));
  } catch {}
  const found = candidates.find((dir) => existsSync(join(dir, "dist/core/extensions/loader.js")));
  if (!found) throw new Error(`Cannot find ${NAME}. Install pi globally or set PI_PACKAGE_DIR.`);
  return found;
}

export const piDir = findPi();

function nested(name) {
  for (const dir of [join(piDir, "node_modules", name), join(piDir, "..", "..", name)]) {
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`Cannot find ${name} next to ${piDir}`);
}

export const tuiDir = nested("@earendil-works/pi-tui");
const jitiDir = nested("jiti");

export const piModule = (path) => import(pathToFileURL(join(piDir, path)).href);
export const tuiModule = (path) => import(pathToFileURL(join(tuiDir, path)).href);

const { createJiti } = await import(pathToFileURL(join(jitiDir, "lib/jiti.mjs")).href);

/** Load package TypeScript the same way Pi does, with host packages aliased. */
export const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-tui": join(tuiDir, "dist/index.js") },
});

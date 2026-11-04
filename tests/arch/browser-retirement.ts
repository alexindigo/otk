// SPDX-License-Identifier: LGPL-3.0-only
import { dependencySpecifiers, sourceInventory } from "./analysis.ts";

const root = new URL("../../", import.meta.url);
export const retiredBrowserPaths = [
  "cdp",
  "browser" + "-fixture",
  "ui-consumer",
  "rendering",
  "message-viewport",
  "message-scale-browser",
  "menu",
  "highlight",
  "error-consumer",
  "legacy-menus-scene",
  "legacy-attention-scene",
  "legacy-sessions-scene",
  "legacy-message-scene",
  "message-heap",
  "notification-browser",
  "remaining-browser",
].map((name) => ["tests", "support", name + ".ts"].join("/"));

export function retiredBrowserImport(path: string, specifier: string): boolean {
  const target = new URL(specifier, new URL(path, root));
  return retiredBrowserPaths.some((retired) =>
    target.href === new URL(retired, root).href
  );
}

/** One dependency audit for architecture tests and the final migration gate. */
export async function oldBrowserConsumers(): Promise<string[]> {
  const inventory = await sourceInventory({ tests: true });
  async function walk(directory: string) {
    for await (const entry of Deno.readDir(new URL(directory, root))) {
      const path = directory + entry.name;
      if (entry.isDirectory) await walk(path + "/");
      else if (/\.[cm]?[jt]sx?$/.test(path)) {
        inventory.set(path, await Deno.readTextFile(new URL(path, root)));
      }
    }
  }
  await walk("scripts/");
  await walk("tests/arch/");
  const consumers: string[] = [];
  for (const [path, source] of inventory) {
    if (path.endsWith(".css")) continue;
    for (const specifier of dependencySpecifiers(source)) {
      if (specifier && retiredBrowserImport(path, specifier)) {
        consumers.push(`${path}: ${specifier}`);
      }
    }
  }
  return consumers.sort();
}

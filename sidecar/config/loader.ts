// SPDX-License-Identifier: LGPL-3.0-only
// Service-only port of globnotes-layered-config/server/config/loader.ts.
import { parse } from "@std/toml";
import { fromFileUrl, join } from "@std/path";
import {
  type LeafType,
  type Schema,
  SERVICE_SCHEMA,
  type ServiceConfig,
} from "./schema.ts";
export type LeafValue = string | number | boolean | string[];
export type Tree = { [node: string]: LeafValue | Tree };
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super("config problems:\n" + problems.join("\n"));
  }
}
export const envName = (p: string) =>
  "OTK_" + p.replaceAll(".", "_").toUpperCase();
const isObject = (v: unknown): v is Tree =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export function schemaLeaves(
  schema: Schema,
  prefix = "",
): [string, LeafType][] {
  return Object.entries(schema).flatMap(([key, node]) => {
    const p = prefix ? `${prefix}.${key}` : key;
    return typeof node === "string"
      ? [[p, node] as [string, LeafType]]
      : schemaLeaves(node, p);
  });
}
function get(tree: Tree, parts: string[]): LeafValue | Tree | undefined {
  let node: LeafValue | Tree | undefined = tree;
  for (const p of parts) {
    if (!isObject(node)) return undefined;
    node = node[p];
  }
  return node;
}
function set(tree: Tree, parts: string[], value: LeafValue): void {
  let node = tree;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(node[p])) node[p] = {};
    node = node[p] as Tree;
  }
  node[parts.at(-1)!] = value;
}
export function mergeLeafWise(target: Tree, source: Tree): void {
  for (const [key, value] of Object.entries(source)) {
    if (isObject(value) && isObject(target[key])) {
      mergeLeafWise(target[key] as Tree, value);
    } else target[key] = structuredClone(value);
  }
}
function matches(value: unknown, type: LeafType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "bool") return typeof value === "boolean";
  if (type === "list") {
    return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
  return typeof value === "number" && Number.isFinite(value) &&
    (type === "float" || Number.isSafeInteger(value));
}
export function parseEnvValue(
  raw: string,
  type: LeafType,
): LeafValue | undefined {
  if (type === "string") return raw;
  if (type === "list") {
    return raw === "" ? [] : raw.split(",").map((s) => s.trim());
  }
  if (type === "bool") {
    return raw === "true" ? true : raw === "false" ? false : undefined;
  }
  if (raw === "" || (type === "int" && !/^-?\d+$/.test(raw))) return undefined;
  const value = Number(raw);
  return matches(value, type) ? value : undefined;
}
function layer(
  tree: Tree,
  schema: Schema,
  target: Tree,
  label: string,
  errors: string[],
  prefix = "",
): void {
  for (const [key, value] of Object.entries(tree)) {
    const p = prefix ? `${prefix}.${key}` : key;
    const s = Object.hasOwn(schema, key) ? schema[key] : undefined;
    const problem = (message: string) =>
      errors.push(`${p} (${envName(p)}): ${message} in ${label}`);
    if (!s) {
      problem("unknown node");
      continue;
    }
    if (typeof s === "string") {
      if (!matches(value, s)) problem(`expected ${s}`);
      else set(target, p.split("."), value as LeafValue);
    } else if (!isObject(value)) problem("expected a section");
    else layer(value, s, target, label, errors, p);
  }
}
function read(file: string, required: boolean, errors: string[]): Tree | null {
  try {
    return parse(Deno.readTextFileSync(file)) as Tree;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound && !required) return null;
    errors.push(`${file}: ${(e as Error).message}`);
    return null;
  }
}
export interface LoadSources {
  defaultsPath: string;
  overlayPath?: string;
  authState?: Tree;
  env: Record<string, string>;
}
export function loadServiceConfig(
  sources: LoadSources,
  schema = SERVICE_SCHEMA,
): { config: ServiceConfig; loaded: string[]; envOverridden: string[] } {
  const errors: string[] = [],
    loaded: string[] = [],
    envOverridden: string[] = [];
  const tree: Tree = {};
  const defaults = read(sources.defaultsPath, true, errors);
  if (defaults) {
    layer(defaults, schema, tree, sources.defaultsPath, errors);
    loaded.push(sources.defaultsPath);
    for (const [p] of schemaLeaves(schema)) {
      if (get(defaults, p.split(".")) === undefined) {
        errors.push(`${p} (${envName(p)}): missing leaf in defaults`);
      }
    }
  }
  if (sources.authState) {
    layer(
      { auth: sources.authState },
      schema,
      tree,
      "generated auth state",
      errors,
    );
  }
  const overlay = sources.env.OTK_CONFIG || sources.overlayPath;
  if (overlay) {
    const data = read(overlay, sources.env.OTK_CONFIG !== undefined, errors);
    if (data) {
      layer(data, schema, tree, overlay, errors);
      loaded.push(overlay);
    }
  }
  const leaves = new Map(schemaLeaves(schema));
  for (const [name, raw] of Object.entries(sources.env)) {
    if (!name.startsWith("OTK_") || name === "OTK_CONFIG") continue;
    const p = name.slice(4).toLowerCase().replaceAll("_", "."),
      type = leaves.get(p);
    if (!type) {
      errors.push(`${p} (${name}): unknown node or section`);
      continue;
    }
    const value = parseEnvValue(raw, type);
    if (value === undefined) errors.push(`${p} (${name}): expected ${type}`);
    else {
      set(tree, p.split("."), value);
      envOverridden.push(p);
    }
  }
  if (errors.length) throw new ConfigError(errors);
  return {
    config: tree as unknown as ServiceConfig,
    loaded,
    envOverridden: envOverridden.sort(),
  };
}
const defaultsPath = fromFileUrl(
  new URL("../../defaults/otk.toml", import.meta.url),
);
const overlayPath = fromFileUrl(
  new URL("../../config/otk.toml", import.meta.url),
);
export function statePath(
  cfg: ServiceConfig,
  env = Deno.env.toObject(),
): string {
  return cfg.state.path ||
    join(
      env.XDG_STATE_HOME || join(env.HOME!, ".local/state"),
      "otk",
      String(cfg.server.port),
    );
}
let memo: ServiceConfig | null = null;
export function config(): ServiceConfig {
  if (memo) return memo;
  const env = Deno.env.toObject(), sources = { defaultsPath, overlayPath, env };
  const initial = loadServiceConfig(sources).config;
  const errors: string[] = [];
  const authState = read(
    join(statePath(initial, env), "auth.toml"),
    false,
    errors,
  );
  if (errors.length) throw new ConfigError(errors);
  const result = loadServiceConfig({
    ...sources,
    authState: authState ?? undefined,
  });
  for (const p of result.loaded) console.info(`config: loaded ${p}`);
  if (result.envOverridden.length) {
    console.info(`config: env overrides ${result.envOverridden.join(", ")}`);
  }
  return memo = result.config;
}

// SPDX-License-Identifier: LGPL-3.0-only
import { basename, isAbsolute, relative, resolve } from "@std/path";
import { ignoredFiles } from "./ignored-files.ts";
import {
  arrayReadCodec,
  catalogFileCodec,
  catalogModelCodec,
  type ProviderReadCodecs,
  type ProviderReaders,
} from "@otk/harness";
import type {
  AgentColor,
  CatalogAgent,
  CatalogConfig,
  CatalogProvenance,
  CommandOption,
  ModelCatalog,
  ModelCostTier,
  ModelRef,
  SkillOption,
} from "@otk/protocol";
import type { OpenCodeClient, V2Client } from "./client.ts";
import { nativeCommands } from "./command-vocabulary.ts";

export type NativeAgent = Awaited<
  ReturnType<OpenCodeClient["agent"]["list"]>
>["data"][number];
export type NativeModel = Awaited<
  ReturnType<OpenCodeClient["model"]["list"]>
>["data"][number];
export type NativeProvider = Awaited<
  ReturnType<OpenCodeClient["provider"]["list"]>
>["data"][number];
export type NativeConfig = Awaited<ReturnType<OpenCodeClient["config"]["get"]>>;
export type NativeSkill = Awaited<
  ReturnType<OpenCodeClient["skill"]["list"]>
>["data"][number];
export type NativeCommand = Awaited<
  ReturnType<OpenCodeClient["command"]["list"]>
>["data"][number];

function color(value?: string): AgentColor | undefined {
  return value && /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)
    ? value as AgentColor
    : value === "primary"
    ? "accent"
    : value === "secondary"
    ? "secondary"
    : undefined;
}
export function mapAgents(rows: readonly NativeAgent[]): CatalogAgent[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.description != null ? { description: row.description } : {}),
    ...(color(row.color) ? { color: color(row.color) } : {}),
    ...(row.model
      ? {
        model: { provider: row.model.providerID, model: row.model.id },
        ...(row.model.variant ? { variant: row.model.variant } : {}),
      }
      : {}),
    primary: !row.hidden && (row.mode === "primary" || row.mode === "all"),
    mention: !row.hidden && (row.mode === "subagent" || row.mode === "all"),
  }));
}
export function mapSkills(rows: readonly NativeSkill[]): SkillOption[] {
  return rows.map(({ id, name, description, path }) => ({
    id,
    name,
    description,
    path,
  }));
}
export function mapCommands(rows: readonly NativeCommand[]): CommandOption[] {
  // The native API does not report command origin. Do not infer it from names.
  return [
    ...rows.map(({ name, description }): CommandOption => ({
      name,
      description,
      aliases: [],
      source: "unknown",
      priority: 20,
    })),
    ...nativeCommands(),
  ];
}
export function mergeCommands(
  commands: CommandOption[],
  skills: SkillOption[],
): CommandOption[] {
  return [
    ...commands,
    ...skills.map((skill): CommandOption => ({
      name: skill.name,
      description: skill.description,
      aliases: [],
      source: "skill",
      skillID: skill.id,
    })),
  ];
}
function selection(
  value: unknown,
): { model: ModelRef; variant?: string } | undefined {
  if (typeof value === "string") {
    const match = value.match(/^([^/#]+)\/([^#]+)(?:#([^#]+))?$/);
    if (match) {
      return {
        model: { provider: match[1], model: match[2] },
        ...(match[3] ? { variant: match[3] } : {}),
      };
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const provider = Reflect.get(value, "providerID"),
    model = Reflect.get(value, "model"),
    variant = Reflect.get(value, "variant");
  if (
    typeof provider !== "string" || !provider || typeof model !== "string" ||
    !model
  ) return;
  return {
    model: { provider, model },
    ...(typeof variant === "string" && variant ? { variant } : {}),
  };
}
export function mapConfig(entries: NativeConfig): CatalogConfig[] {
  return entries.map((entry, order) => ({
    type: entry.type,
    ...(entry.path ? { path: entry.path } : {}),
    order,
    ...(entry.type === "document"
      ? {
        ...selection(entry.info.model),
        ...(entry.info.default_agent
          ? { defaultAgent: entry.info.default_agent }
          : {}),
      }
      : {}),
  }));
}
function provenance(
  entries: NativeConfig,
  selected: (
    entry: Extract<NativeConfig[number], { type: "document" }>,
  ) => boolean,
): CatalogProvenance[] {
  return [
    { source: "native" },
    ...entries.flatMap((entry, order) =>
      entry.type === "document" && selected(entry)
        ? [{
          source: "configuration" as const,
          ...(entry.path ? { path: entry.path } : {}),
          order,
        }]
        : []
    ),
  ];
}
function costs(
  rows: NativeModel["cost"],
): { costs: ModelCostTier[]; free: boolean | null } {
  const result: ModelCostTier[] = [];
  let unknown = !rows.length, positive = false;
  for (const row of rows) {
    const rates = [row.input, row.output, row.cache?.read, row.cache?.write];
    positive ||= rates.some((rate) =>
      typeof rate === "number" && Number.isFinite(rate) && rate > 0
    );
    if (
      !rates.every((rate) =>
        typeof rate === "number" && Number.isFinite(rate) && rate >= 0
      ) ||
      (row.tier &&
        (row.tier.type !== "context" || !Number.isSafeInteger(row.tier.size) ||
          row.tier.size < 0))
    ) {
      unknown = true;
      continue;
    }
    result.push({
      input: row.input,
      output: row.output,
      cache: { read: row.cache.read, write: row.cache.write },
      ...(row.tier ? { tier: { type: "context", size: row.tier.size } } : {}),
    });
  }
  return { costs: result, free: positive ? false : unknown ? null : true };
}
export function mapModels(
  models: readonly NativeModel[],
  providers: readonly NativeProvider[],
  applied: NativeModel | undefined,
  entries: NativeConfig,
): ModelCatalog {
  const catalog: ModelCatalog = { providers: [], defaultState: "unknown" };
  for (const provider of providers) {
    catalog.providers.push({
      id: provider.id,
      name: provider.name,
      availability: provider.activation === "auto"
        ? "automatic"
        : provider.activation,
      provenance: provenance(
        entries,
        (entry) => !!entry.info.providers?.[provider.id],
      ),
      models: models.filter((model) =>
        model.providerID === provider.id && model.enabled &&
        (!model.type || model.type === "chat")
      ).map((model) => {
        const price = costs(model.cost);
        return {
          id: model.id,
          name: model.name,
          status: model.status,
          variants: model.variants.map((variant) => variant.id),
          free: price.free,
          ...(price.costs.length ? { costs: price.costs } : {}),
          ...(price.costs.length === 1 && !price.costs[0].tier &&
              model.cost.length === 1
            ? { cost: price.costs[0] }
            : {}),
          ...(Number.isFinite(model.limit.context) && model.limit.context > 0
            ? { contextLimit: model.limit.context }
            : {}),
          ...(Number.isFinite(model.time.released) && model.time.released > 0
            ? { releaseDate: new Date(model.time.released).toISOString() }
            : {}),
          provenance: provenance(
            entries,
            (entry) =>
              !!entry.info.providers?.[provider.id]?.models?.[model.id],
          ),
        };
      }),
    });
  }
  if (
    applied &&
    catalog.providers.some((provider) =>
      provider.id === applied.providerID &&
      provider.models.some((model) => model.id === applied.id)
    )
  ) {
    const configured = mapConfig(entries).filter((entry) => entry.model).at(-1);
    const matches = configured?.model?.provider === applied.providerID &&
      configured.model.model === applied.id;
    catalog.default = { provider: applied.providerID, model: applied.id };
    catalog.defaultState = matches ? "configured" : "applied";
    if (
      matches && configured.variant &&
      applied.variants.some((variant) => variant.id === configured.variant)
    ) catalog.defaultVariant = configured.variant;
    catalog.provenance = provenance(
      entries,
      (entry) => !!selection(entry.info.model),
    );
  }
  return catalog;
}

/** Selected worker contributions, with native schemas/endpoints confined to this package. */
export function catalogReaders(
  client: () => V2Client,
  wait: <T>(value: Promise<T>) => Promise<T> = (value) => value,
): ProviderReaders {
  return {
    "catalog.agents": async ({ directory }, signal) =>
      mapAgents(
        (await client().read(
          (api) => api.agent.list({ location: { directory } }, { signal }),
          signal,
        ))
          .data,
      ),
    "catalog.commands": async ({ directory }, signal) =>
      mapCommands(
        (await client().read(
          (api) => api.command.list({ location: { directory } }, { signal }),
          signal,
        ))
          .data,
      ),
    "catalog.skills": async ({ directory }, signal) =>
      mapSkills(
        (await client().read(
          (api) => api.skill.list({ location: { directory } }, { signal }),
          signal,
        ))
          .data,
      ),
    "catalog.config": async ({ directory }, signal) =>
      mapConfig(
        await client().read(
          (api) => api.config.get({ location: { directory } }, { signal }),
          signal,
        ),
      ),
    "catalog.models": async ({ directory }, signal) => {
      const current = client(), input = { location: { directory } };
      const models = await current.read(
        (api) => api.model.list(input, { signal }),
        signal,
      );
      const providers = await current.read(
        (api) => api.provider.list(input, { signal }),
        signal,
      );
      const applied = await current.read(
        (api) => api.model.default(input, { signal }),
        signal,
      );
      const config = await current.read(
        (api) => api.config.get(input, { signal }),
        signal,
      );
      return mapModels(
        models.data,
        providers.data,
        applied.data ?? undefined,
        config,
      );
    },
    "catalog.resources": async ({ directory }, signal) =>
      (await client().read(
        (api) =>
          api.mcp.resource.catalog({ location: { directory } }, { signal }),
        signal,
      )).data.resources.map(({ name, description, mimeType, uri, server }) => ({
        name,
        description,
        mime: mimeType ?? "text/plain",
        uri,
        server,
      })),
    "catalog.resourceTemplates": async ({ directory }, signal) =>
      (await client().read(
        (api) =>
          api.mcp.resource.catalog({ location: { directory } }, { signal }),
        signal,
      )).data.templates.map((
        { name, description, mimeType, uriTemplate, server },
      ) => ({ name, description, mime: mimeType, uriTemplate, server })),
    "catalog.files": async ({ directory, path }, signal) => {
      const target = resolve(directory, path),
        local = relative(directory, target);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
        throw new Error("File listing escaped its project");
      }
      const physical = await wait(Deno.realPath(target));
      signal.throwIfAborted();
      const entries = await client().read(
        (api) => api.file.list({ location: { directory }, path }, { signal }),
        signal,
      );
      const items = entries.data.filter((entry) =>
        basename(entry.path.replace(/\/$/, "")) !== ".git"
      ).map((entry) => {
        const absolute = resolve(directory, entry.path),
          normalized = relative(directory, absolute);
        if (
          normalized === ".." || normalized.startsWith("../") ||
          isAbsolute(normalized) || absolute === target ||
          resolve(absolute, "..") !== target
        ) throw new Error("Malformed native file listing");
        return {
          path: normalized,
          canonicalPath: absolute,
          directory: entry.type === "directory",
        };
      });
      const ignored = await wait(
        ignoredFiles(
          directory,
          items.map((entry) => entry.path + (entry.directory ? "/" : "")),
          signal,
        ),
      );
      return {
        physical,
        items: items.filter((entry) =>
          !ignored.has(entry.path + (entry.directory ? "/" : ""))
        ),
      };
    },
  };
}
export const catalogReadCodecs: ProviderReadCodecs = {
  "catalog.agents": arrayReadCodec(),
  "catalog.commands": arrayReadCodec(),
  "catalog.skills": arrayReadCodec(),
  "catalog.models": catalogModelCodec,
  "catalog.resources": arrayReadCodec(),
  "catalog.resourceTemplates": arrayReadCodec(),
  "catalog.config": arrayReadCodec(),
  "catalog.files": catalogFileCodec,
};

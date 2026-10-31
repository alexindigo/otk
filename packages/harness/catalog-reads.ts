// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CatalogAgent,
  CatalogFile,
  CommandOption,
  ModelCatalog,
  QuestionRequest,
  ResourceOption,
  SkillOption,
} from "@otk/protocol";
import type { ProviderReadCodec } from "./provider-reads.ts";

export interface CatalogFileListing {
  physical: string;
  items: CatalogFile[];
}
export interface AgentReadKinds {
  "catalog.agents": {
    input: { directory: string };
    result: CatalogAgent[];
    chunk: CatalogAgent[];
  };
}
export interface CommandReadKinds {
  "catalog.commands": {
    input: { directory: string };
    result: CommandOption[];
    chunk: CommandOption[];
  };
}
export interface SkillReadKinds {
  "catalog.skills": {
    input: { directory: string };
    result: SkillOption[];
    chunk: SkillOption[];
  };
}
export interface ResourceReadKinds {
  "catalog.resources": {
    input: { directory: string };
    result: ResourceOption[];
    chunk: ResourceOption[];
  };
}
export interface QuestionReadKinds {
  "catalog.questions": {
    input: { directory: string };
    result: QuestionRequest[];
    chunk: QuestionRequest[];
  };
}
export type CatalogModelItem =
  | { kind: "catalog"; default?: ModelCatalog["default"] }
  | { kind: "provider"; id: string; name: string }
  | {
    kind: "model";
    providerID: string;
    model: ModelCatalog["providers"][number]["models"][number];
  };
export interface ModelReadKinds {
  "catalog.models": {
    input: { directory: string };
    result: ModelCatalog;
    chunk: CatalogModelItem[];
  };
}
export interface FileReadKinds {
  "catalog.files": {
    input: { directory: string; path: string };
    result: CatalogFileListing;
    chunk: { physical: string; items: CatalogFile[] };
  };
}

/** Feature-selected codecs keep complete models/provider metadata across row credits. */
export const catalogModelCodec: ProviderReadCodec<"catalog.models"> = {
  *chunks(value, rows) {
    function* entries(): Generator<CatalogModelItem> {
      yield { kind: "catalog", default: value.default };
      for (const provider of value.providers) {
        yield { kind: "provider", id: provider.id, name: provider.name };
        for (const model of provider.models) {
          yield { kind: "model", providerID: provider.id, model };
        }
      }
    }
    let items: CatalogModelItem[] = [];
    for (const item of entries()) {
      items.push(item);
      if (items.length === rows) {
        yield items;
        items = [];
      }
    }
    if (items.length) yield items;
  },
  create() {
    const value: ModelCatalog = { providers: [] };
    const providers = new Map<string, ModelCatalog["providers"][number]>();
    let header = false;
    return {
      append(items) {
        for (const item of items) {
          if (item.kind === "catalog") {
            if (header) throw new Error("Duplicate catalog header");
            header = true;
            if (item.default) value.default = item.default;
          } else if (item.kind === "provider") {
            if (providers.has(item.id)) {
              throw new Error("Duplicate catalog provider");
            }
            const provider = { id: item.id, name: item.name, models: [] };
            providers.set(item.id, provider);
            value.providers.push(provider);
          } else {
            const provider = providers.get(item.providerID);
            if (
              !provider ||
              provider.models.some((model) => model.id === item.model.id)
            ) throw new Error("Invalid catalog model identity");
            provider.models.push(item.model);
          }
        }
      },
      finish() {
        if (!header) throw new Error("Missing catalog header");
        return value;
      },
    };
  },
};
export const catalogFileCodec: ProviderReadCodec<"catalog.files"> = {
  *chunks(value, rows) {
    for (
      let offset = 0;
      offset < value.items.length || offset === 0;
      offset += rows
    ) {
      yield {
        physical: value.physical,
        items: value.items.slice(offset, offset + rows),
      };
    }
  },
  create() {
    let physical: string | undefined;
    const items: CatalogFile[] = [];
    return {
      append(chunk) {
        if (physical !== undefined && physical !== chunk.physical) {
          throw new Error("Catalog directory changed during publication");
        }
        physical = chunk.physical;
        items.push(...chunk.items);
      },
      finish() {
        if (physical === undefined) {
          throw new Error("Missing catalog directory");
        }
        return { physical, items };
      },
    };
  },
};

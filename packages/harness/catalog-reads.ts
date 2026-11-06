// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CatalogAgent,
  CatalogFile,
  CatalogModelItem,
  CommandOption,
  ModelCatalog,
  PermissionRequest,
  QuestionRequest,
  ResourceOption,
  SessionMetadata,
  SkillOption,
} from "@otk/protocol";
import type { ProviderReadCodec } from "./provider-reads.ts";
import { modelCatalogCodec } from "@otk/protocol";

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
  "activity.status": {
    input: { directory: string };
    result: (Pick<SessionMetadata, "id" | "status" | "retry">)[];
    chunk: (Pick<SessionMetadata, "id" | "status" | "retry">)[];
  };
  "activity.permissions": {
    input: { directory: string };
    result: PermissionRequest[];
    chunk: PermissionRequest[];
  };
  "catalog.questions": {
    input: { directory: string };
    result: QuestionRequest[];
    chunk: QuestionRequest[];
  };
}
export type { CatalogModelItem } from "@otk/protocol";
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
export const catalogModelCodec: ProviderReadCodec<"catalog.models"> =
  modelCatalogCodec;
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

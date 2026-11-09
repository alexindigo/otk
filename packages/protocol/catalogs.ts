// SPDX-License-Identifier: LGPL-3.0-only
import type { PublicFailure } from "./requests.ts";
import type { PathSemantics } from "./paths.ts";
import type {
  ConfigCatalogKinds,
  ConfigChunkKinds,
} from "./catalogs/config.ts";
export type { CatalogConfig, CatalogProvenance } from "./catalogs/config.ts";
import type { RequestMetadata } from "./request-metadata.ts";
import type { AgentCatalogKinds, AgentChunkKinds } from "./catalogs/agents.ts";
import type {
  CommandCatalogKinds,
  CommandChunkKinds,
} from "./catalogs/commands.ts";
import type { SkillCatalogKinds, SkillChunkKinds } from "./catalogs/skills.ts";
import type { ModelCatalogKinds, ModelChunkKinds } from "./catalogs/models.ts";
import type {
  ResourceCatalogKinds,
  ResourceChunkKinds,
} from "./catalogs/resources.ts";
import type { FileCatalogKinds, FileChunkKinds } from "./catalogs/files.ts";
import type {
  QuestionCatalogKinds,
  QuestionChunkKinds,
} from "./catalogs/questions.ts";
export type {
  AgentCatalogKinds,
  AgentChunkKinds,
  CatalogAgent,
} from "./catalogs/agents.ts";
export type {
  CommandCatalogKinds,
  CommandChunkKinds,
} from "./catalogs/commands.ts";
export type {
  CatalogFile,
  FileCatalogKinds,
  FileChunkKinds,
} from "./catalogs/files.ts";
export type {
  SkillCatalogKinds,
  SkillChunkKinds,
  SkillOption,
} from "./catalogs/skills.ts";
export type {
  CatalogModelItem,
  ModelCatalogKinds,
  ModelChunkKinds,
} from "./catalogs/models.ts";
export type {
  ResourceCatalogKinds,
  ResourceChunkKinds,
  ResourceTemplateOption,
} from "./catalogs/resources.ts";
export type {
  QuestionCatalogKinds,
  QuestionChunkKinds,
} from "./catalogs/questions.ts";
/** Open feature contributions. Acquisition/transport machinery knows no kind names. */
export interface DirectoryCatalogKinds
  extends
    AgentCatalogKinds,
    CommandCatalogKinds,
    SkillCatalogKinds,
    ModelCatalogKinds,
    ResourceCatalogKinds,
    FileCatalogKinds,
    QuestionCatalogKinds,
    ConfigCatalogKinds {}
export interface CatalogValue<T> {
  state: "digesting" | "ready" | "unavailable";
  revision: number;
  value?: T;
  failure?: PublicFailure;
}
export type CatalogValues = {
  [K in keyof DirectoryCatalogKinds]?: CatalogValue<DirectoryCatalogKinds[K]>;
};
export interface DirectoryCatalog {
  directory: string;
  generation: string;
  revision: number;
  paths: PathSemantics;
  values: CatalogValues;
}
export interface CatalogRpcMethods {
  "catalogs.watch": { params: { directory: string }; result: DirectoryCatalog };
  "catalogs.refresh": { params: { directory: string }; result: null };
}
export interface CatalogsCapability {
  watch(
    directory: string,
    listener: (value: DirectoryCatalog) => void,
    signal: AbortSignal,
  ): Promise<DirectoryCatalog>;
  refresh(directory: string, signal?: AbortSignal): Promise<void>;
}
export interface CatalogsCapabilities {
  catalogs: CatalogsCapability;
}
export const catalogRequestMetadata: Readonly<Record<string, RequestMetadata>> =
  {
    "catalogs.watch": { kind: "lease", pending: "Preparing project choices" },
    "catalogs.refresh": { kind: "read", pending: "Refreshing project choices" },
  };
/** Each selected feature contributes its own item contract and codec. */
export interface CatalogChunkKinds
  extends
    AgentChunkKinds,
    CommandChunkKinds,
    SkillChunkKinds,
    ModelChunkKinds,
    ResourceChunkKinds,
    FileChunkKinds,
    QuestionChunkKinds,
    ConfigChunkKinds {}
export type CatalogChunk = {
  [K in keyof CatalogChunkKinds]: {
    t: "catalog.chunk";
    directory: string;
    generation: string;
    revision: number;
    transfer: string;
    part: number;
    last: boolean;
    kind: K;
    items: CatalogChunkKinds[K][];
  };
}[keyof CatalogChunkKinds];
export interface CatalogCodec<
  K extends keyof DirectoryCatalogKinds & keyof CatalogChunkKinds,
> {
  chunks(
    value: DirectoryCatalogKinds[K],
    rows: number,
  ): Iterable<CatalogChunkKinds[K][]>;
  create(): {
    append(items: CatalogChunkKinds[K][]): void;
    finish(): DirectoryCatalogKinds[K];
  };
}
export type CatalogCodecs = {
  [K in keyof DirectoryCatalogKinds & keyof CatalogChunkKinds]?: CatalogCodec<
    K
  >;
};

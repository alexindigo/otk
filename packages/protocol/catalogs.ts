// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AgentOption,
  CommandOption,
  FileMatch,
  ResourceOption,
} from "./rpc.ts";
import type { ModelCatalog } from "./models.ts";
import type { QuestionRequest } from "./content.ts";
import type { PublicFailure } from "./requests.ts";

export interface CatalogAgent extends AgentOption {
  primary: boolean;
  mention: boolean;
}
export interface CatalogFile extends FileMatch {
  canonicalPath: string;
}
export interface SkillOption {
  name: string;
  description?: string;
}
export interface AgentCatalogKinds {
  agents: CatalogAgent[];
}
export interface CommandCatalogKinds {
  commands: CommandOption[];
}
export interface SkillCatalogKinds {
  skills: SkillOption[];
}
export interface ModelCatalogKinds {
  models: ModelCatalog;
}
export interface ResourceCatalogKinds {
  resources: ResourceOption[];
}
export interface FileCatalogKinds {
  files: CatalogFile[];
}
export interface QuestionCatalogKinds {
  questions: QuestionRequest[];
}
/** Open feature contributions. Acquisition/transport machinery knows no kind names. */
export interface DirectoryCatalogKinds
  extends
    AgentCatalogKinds,
    CommandCatalogKinds,
    SkillCatalogKinds,
    ModelCatalogKinds,
    ResourceCatalogKinds,
    FileCatalogKinds,
    QuestionCatalogKinds {}
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
  paths: { style: "posix" | "win32"; separator: "/" | "\\" };
  values: CatalogValues;
}

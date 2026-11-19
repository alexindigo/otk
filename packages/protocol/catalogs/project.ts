// SPDX-License-Identifier: LGPL-3.0-only
import { arrayCatalogCodec } from "./arrays.ts";

/** Native project presentation, independent of durable checkout membership. */
export interface CatalogProject {
  id: string;
  name?: string;
  icon?: string;
  /** Concrete display color selected by the producing harness. */
  color?: string;
  repository?: string;
  root?: string;
  machine?: string;
}
/** Current working-folder facts; absent fields are unreported, never zero. */
export interface CatalogRepository {
  branch?: string;
  changes?: string;
}
export interface ProjectCatalogKinds {
  project: CatalogProject[];
  repository: CatalogRepository[];
}
export interface ProjectChunkKinds {
  project: CatalogProject;
  repository: CatalogRepository;
}
export const projectCatalogCodec = arrayCatalogCodec<"project">();
export const repositoryCatalogCodec = arrayCatalogCodec<"repository">();

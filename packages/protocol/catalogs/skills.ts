// SPDX-License-Identifier: LGPL-3.0-only
import { arrayCatalogCodec } from "./arrays.ts";
export interface SkillOption {
  id?: string;
  path?: string;
  name: string;
  description?: string;
}
export interface SkillCatalogKinds {
  skills: SkillOption[];
}
export interface SkillChunkKinds {
  skills: SkillOption;
}
export const skillsCatalogCodec = arrayCatalogCodec<"skills">();

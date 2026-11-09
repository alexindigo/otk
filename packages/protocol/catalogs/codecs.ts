// SPDX-License-Identifier: LGPL-3.0-only
import type { CatalogCodecs } from "../catalogs.ts";
import { agentsCatalogCodec } from "./agents.ts";
import { commandsCatalogCodec } from "./commands.ts";
import { skillsCatalogCodec } from "./skills.ts";
import {
  resourcesCatalogCodec,
  resourceTemplatesCatalogCodec,
} from "./resources.ts";
import { configCatalogCodec } from "./config.ts";
import { questionsCatalogCodec } from "./questions.ts";
import { filesCatalogCodec } from "./files.ts";
import { modelCatalogCodec } from "./models.ts";
/** Shipped feature composition; the transport accepts an injected open codec map. */
export function createCatalogCodecs(): CatalogCodecs {
  return {
    agents: agentsCatalogCodec,
    commands: commandsCatalogCodec,
    skills: skillsCatalogCodec,
    resources: resourcesCatalogCodec,
    resourceTemplates: resourceTemplatesCatalogCodec,
    config: configCatalogCodec,
    questions: questionsCatalogCodec,
    files: filesCatalogCodec,
    models: modelCatalogCodec,
  };
}

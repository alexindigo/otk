// SPDX-License-Identifier: LGPL-3.0-only
import type { PreferenceRegistry } from "../mod.ts";
function contributionTypes(registry: PreferenceRegistry): void {
  registry.register({
    // @ts-expect-error undeclared keys have no contributed contract
    key: "not.declared",
    default: true,
    label: "Bad",
    validate: (v: unknown): v is boolean => typeof v === "boolean",
  });
  registry.register({
    key: "timestamps",
    // @ts-expect-error default must match the feature's value contract
    default: "yes",
    label: "Bad",
    validate: (v: unknown): v is boolean => typeof v === "boolean",
  });
  registry.register({
    key: "timestamps",
    default: true,
    label: "Bad",
    // @ts-expect-error validator must narrow to the feature's value contract
    validate: (v: unknown): v is string => typeof v === "string",
  });
}
void contributionTypes;

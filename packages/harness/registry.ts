// SPDX-License-Identifier: LGPL-3.0-only
import {
  type Capabilities,
  type CapabilityName,
  HarnessError,
} from "./types.ts";
import { capabilityNames } from "@otk/protocol";

/** Typed capability composition; it has no knowledge of implementations. */
export class CapabilityRegistry {
  #capabilities: Capabilities = {};
  register<K extends CapabilityName>(
    name: K,
    capability: NonNullable<Capabilities[K]>,
  ): void {
    if (this.#capabilities[name]) {
      throw new HarnessError(
        "capability",
        `Capability already registered: ${name}`,
      );
    }
    this.#capabilities[name] = capability;
  }
  get capabilities(): Readonly<Capabilities> {
    return Object.freeze({ ...this.#capabilities });
  }
  names(): CapabilityName[] {
    return capabilityNames(this.#capabilities);
  }
}

/** Require an optional capability at a consumer's operation boundary. */
export function requireCapability<K extends CapabilityName>(
  capabilities: Readonly<Capabilities>,
  name: K,
): NonNullable<Capabilities[K]> {
  const capability = capabilities[name];
  if (!capability) {
    throw new HarnessError(
      "capability",
      `Harness capability unavailable: ${name}`,
    );
  }
  return capability;
}

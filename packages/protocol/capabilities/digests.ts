// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "../request-metadata.ts";
export const digestsRequestMetadata: Readonly<Record<string, RequestMetadata>> =
  { "digests.scope": { kind: "lease", pending: "Loading active scope" } };
export interface DigestScope {
  directory?: string;
  sessions: string[];
}
export interface DigestsCapability {
  scope(owner: string, value: DigestScope): void;
  release(owner: string): void;
}
export interface DigestsCapabilities {
  digests: DigestsCapability;
}
export interface DigestsRpcMethods {
  "digests.scope": { params: DigestScope; result: null };
}

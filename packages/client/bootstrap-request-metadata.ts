// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "@otk/protocol";

/** Bootstrap owns one vocabulary for request classification and presentation. */
export const bootstrapRequestMetadata: Readonly<
  Record<string, RequestMetadata>
> = {
  "bootstrap.session": { kind: "read", pending: "Connecting" },
  "bootstrap.health": { kind: "read", pending: "Checking server" },
  "bootstrap.login": { kind: "mutation", pending: "Signing in" },
  "bootstrap.setup": { kind: "mutation", pending: "Configuring server" },
  "bootstrap.logout": { kind: "mutation", pending: "Signing out" },
};

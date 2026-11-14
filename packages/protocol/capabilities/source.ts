// SPDX-License-Identifier: LGPL-3.0-only
import type { NativeSourceView } from "../content.ts";
/** The plugin that minted a source reference derives its exact source. */
export interface SourceCapability {
  getSource(
    sessionID: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<NativeSourceView>;
}
export interface SourceCapabilities {
  source: SourceCapability;
}

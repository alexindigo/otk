// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestPressure } from "./digest/protocol.ts";
/** Optional injected observations; no environment flag or public diagnostic RPC. */
export type SectionObserver = (name: string, elapsedMs: number) => void;
export interface ServingDiagnostics {
  section: SectionObserver;
  dispatch?(value: import("@otk/harness").EventDispatchPressure): void;
  admission?(): void;
  pressure?(value: DigestPressure): void;
}

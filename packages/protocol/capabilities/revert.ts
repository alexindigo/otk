// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession, RevertCommit } from "../content.ts";
import type { OperationContext } from "../requests.ts";
export interface RevertCapability {
  revert(
    sessionID: string,
    messageID: string,
    operation?: OperationContext,
  ): Promise<ContentSession>;
}
export interface RevertCapabilities {
  /** Independent of prompt history. Without history, the browser warns that the
   * reverted branch cannot be preserved for Unrevert after sending. */
  revert: RevertCapability;
  /** Independent advertisement for explicit file rollback. */
  revertCode: RevertCapability;
  /** Only harnesses with native commit-specific evidence advertise this. */
  revertCommit: RevertCommitCapability;
}
export interface RevertCommitCapability {
  latest(sessionID: string): RevertCommit | undefined;
}
export const legacyRevertCapabilities: readonly (keyof RevertCapabilities)[] = [
  "revert",
];

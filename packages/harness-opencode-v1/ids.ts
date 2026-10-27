// SPDX-License-Identifier: LGPL-3.0-only
import { isSessionID } from "@otk/protocol";
import { HarnessError } from "@otk/harness";

/** The only opencode-v1 session codec. Legacy conversion is upgrade-only. */
export const opencodeV1SessionID: {
  encode(native: string): string;
  decode(otk: string): string;
  legacy(value: string): string;
} = {
  encode(native: string): string {
    if (
      typeof native !== "string" || !/^[A-Za-z0-9_-]+$/.test(native) ||
      isSessionID(native)
    ) {
      throw new HarnessError(
        "params",
        "Expected a native opencode-v1 session ID",
      );
    }
    return `opcv1-${native}`;
  },
  decode(otk: string): string {
    if (!isSessionID(otk) || !otk.startsWith("opcv1-")) {
      throw new HarnessError("params", "Expected an opencode-v1 session ID");
    }
    return otk.slice(6);
  },
  legacy(value: string): string {
    if (isSessionID(value)) return value;
    return /^ses_[A-Za-z0-9_-]+$/.test(value)
      ? opencodeV1SessionID.encode(value)
      : value;
  },
};

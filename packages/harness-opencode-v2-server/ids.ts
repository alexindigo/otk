// SPDX-License-Identifier: LGPL-3.0-only
import { isSessionID } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
export const opencodeV2SessionID: {
  is(id: string): boolean;
  encode(native: string): string;
  decode(id: string): string;
} = {
  is(id: string): boolean {
    return isSessionID(id) && id.startsWith("opcv2-");
  },
  encode(native: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(native) || isSessionID(native)) {
      throw new HarnessError(
        "params",
        "Expected a native opencode-v2 session ID",
      );
    }
    return `opcv2-${native}`;
  },
  decode(id: string): string {
    if (!isSessionID(id) || !id.startsWith("opcv2-")) {
      throw new HarnessError("params", "Expected an opencode-v2 session ID");
    }
    return id.slice(6);
  },
};

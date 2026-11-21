// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";

export interface TerminalInfo {
  checkout?: string;
  ownerSessionID?: string;
  id: string;
  title: string;
  foreground: string | null;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
}
export const terminalRequestMetadata: Readonly<
  Record<string, RequestMetadata>
> = {
  "terminal.list": { kind: "read", pending: "Loading terminals" },
  "terminal.create": { kind: "mutation", pending: "Creating terminal" },
  "terminal.close": { kind: "mutation", pending: "Closing terminal" },
};

export interface TerminalRpcMethods {
  "terminal.list": { params: { sessionID: string }; result: TerminalInfo[] };
  "terminal.create": {
    params: { sessionID: string; cols: number; rows: number };
    result: TerminalInfo;
  };
  "terminal.close": {
    params: { sessionID: string; terminalID: string };
    result: null;
  };
}
export interface TerminalRequestReceipts {
  "terminal-created": { id: string };
  "terminal-closed": { completed: true };
}

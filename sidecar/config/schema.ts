// SPDX-License-Identifier: LGPL-3.0-only
export type LeafType = "string" | "int" | "float" | "bool" | "list";
export type Schema = { [node: string]: LeafType | Schema };
export const SERVICE_SCHEMA: Schema = {
  server: { host: "string", port: "int", origins: "list" },
  auth: {
    type: "string",
    username: "string",
    password: "string",
    secretkey: "string",
    totpkey: "string",
    sessionexpirydays: "int",
    cookiename: "string",
    cookiesamesite: "string",
  },
  state: { path: "string" },
  harness: {
    type: "string",
    url: "string",
    username: "string",
    password: "string",
    db: "string",
    heartbeattimeout: "int",
    reconnectmax: "int",
  },
  index: { days: "int" },
};
export interface ServiceConfig {
  server: { host: string; port: number; origins: string[] };
  auth: {
    type: string;
    username: string;
    password: string;
    secretkey: string;
    totpkey: string;
    sessionexpirydays: number;
    cookiename: string;
    cookiesamesite: string;
  };
  state: { path: string };
  harness: {
    type: string;
    url: string;
    username: string;
    password: string;
    db: string;
    heartbeattimeout: number;
    reconnectmax: number;
  };
  index: { days: number };
}

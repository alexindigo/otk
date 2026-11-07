// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestPolicy } from "@otk/harness";
import type {
  AttachmentPolicy,
  ClientRequestPolicy,
  LogLevel,
  MessagePolicy,
  RequestPolicy,
} from "@otk/protocol";
export type LeafType = "string" | "int" | "float" | "bool" | "list";
export type Schema = { [node: string]: LeafType | Schema };
export const SERVICE_SCHEMA: Schema = {
  log: { level: "string" },
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
  storage: { busyms: "int" },
  harness: {
    type: "string",
    url: "string",
    username: "string",
    password: "string",
    db: "string",
    heartbeattimeout: "int",
    reconnectmax: "int",
    requestms: "int",
  },
  requests: {
    windowms: "int",
    retentionms: "int",
    maxpending: "int",
    inputbytes: "int",
    resultbytes: "int",
    resumebatch: "int",
    sweepbatch: "int",
    livenessms: "int",
    stoppingms: "int",
  },
  connection: {
    helloms: "int",
    pingms: "int",
    silencems: "int",
    httpms: "int",
    retrybase: "int",
    retrymax: "int",
  },
  index: { days: "int" },
  catalogs: { concurrency: "int", statconcurrency: "int", pending: "int" },
  attachments: { concurrency: "int", maxrefs: "int", maxbytes: "int" },
  messages: {
    coolms: "int",
    preloadms: "int",
    concurrency: "int",
    replayops: "int",
    replaybytes: "int",
    recoveryconcurrency: "int",
    recoverypending: "int",
    retryms: "int",
  },
  digest: {
    idlems: "int",
    parallel: "int",
    background: "bool",
    batch: "int",
    slicems: "int",
    cpu: "float",
    memoryreserve: "int",
    maxpending: "int",
    publishrows: "int",
    retryms: "int",
    busyms: "int",
  },
};
export interface ServiceConfig {
  log: { level: LogLevel };
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
  storage: { busyms: number };
  harness: {
    type: string;
    url: string;
    username: string;
    password: string;
    db: string;
    heartbeattimeout: number;
    reconnectmax: number;
    requestms: number;
  };
  requests: RequestPolicy;
  connection: {
    helloms: number;
    pingms: number;
    silencems: number;
    httpms: number;
    retrybase: number;
    retrymax: number;
  };
  index: { days: number };
  catalogs: { concurrency: number; statconcurrency: number; pending: number };
  attachments: AttachmentPolicy;
  digest: DigestPolicy;
  messages: MessagePolicy;
}
/** Explicit safe subset; never serialize the service config into welcome/HTTP. */
export function clientRequestPolicy(
  cfg: Pick<ServiceConfig, "requests" | "connection">,
): ClientRequestPolicy {
  const { livenessms, stoppingms, resumebatch, maxpending, inputbytes } =
    cfg.requests;
  const { httpms, pingms, silencems, retrybase, retrymax } = cfg.connection;
  return {
    livenessms,
    stoppingms,
    resumebatch,
    maxpending,
    inputbytes,
    httpms,
    pingms,
    silencems,
    retrybase,
    retrymax,
  };
}

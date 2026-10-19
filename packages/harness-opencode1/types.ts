// SPDX-License-Identifier: LGPL-3.0-only
// Minimal 1.x wire types, characterized from the local 1.17.13 OpenAPI snapshot.
// User model.variant is also confirmed by the live stock 1.18.34 schema.
export interface Session {
  id: string;
  parentID?: string | null;
  projectID: string;
  directory: string;
  title: string;
  time: { created: number; updated: number; archived?: number };
  revert?: { messageID: string; diff?: string };
  summary?: { diffs?: RawDiff[] };
}
interface MessageInfo {
  id: string;
  sessionID: string;
  time: { created: number; completed?: number };
  parentID?: string | null;
  model?:
    | { providerID: string; modelID: string; variant?: string | null }
    | null;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  error?: { name: string; data: { message?: string; ref?: string } };
}
/** Optional native metadata can use null; the neutral mapping owns absence. */
export type Info =
  & MessageInfo
  & (
    | { role: "user"; agent?: string | null }
    | { role: "assistant"; agent: string }
  );
export interface RawPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  time?: { start: number; end?: number };
  filename?: string;
  mime?: string;
  url?: string;
  name?: string;
  cost?: number;
  tokens?: Info["tokens"];
  source?: {
    path?: string | null;
    range?: { start: { line: number }; end: { line: number } };
  };
  metadata?: Record<string, unknown>;
  tool?: string;
  callID?: string;
  state?: {
    status: "pending" | "running" | "completed" | "error";
    input: Record<string, unknown>;
    title?: string;
    output?: string;
    error?: string;
    time?: { start: number; end?: number };
    metadata?: Record<string, unknown>;
  };
}
export interface RawPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
  tool?: { messageID: string; callID: string } | null;
}
export interface RawDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}
export interface RawQuestion {
  id: string;
  sessionID: string;
  questions: {
    header?: string;
    question: string;
    options: { label: string; description?: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
}
export interface Envelope {
  directory?: string;
  payload: { type: string; id?: string; properties?: Record<string, unknown> };
}
/** Native prompt input parts; no stored IDs or session metadata. */
export type RawPromptPart =
  | { type: "text"; text: string }
  | { type: "agent"; name: string }
  | {
    type: "file";
    filename: string;
    mime: string;
    url: string;
    source?: {
      type: "resource";
      clientName: string;
      uri: string;
      text: { start: number; end: number; value: string };
    };
  };

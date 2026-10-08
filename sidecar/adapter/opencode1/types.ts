// SPDX-License-Identifier: LGPL-3.0-only
// Minimal 1.x wire types, characterized from the local 1.17.13 OpenAPI snapshot.
export interface Session {
  id: string;
  parentID?: string;
  projectID: string;
  directory: string;
  title: string;
  time: { created: number; updated: number; archived?: number };
}
export interface Info {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  agent: string;
  model?: { providerID: string; modelID: string };
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  error?: { name: string; data: { message?: string } };
}
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
    path?: string;
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
  tool?: { messageID: string; callID: string };
}
export interface RawDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}
export interface Envelope {
  directory?: string;
  payload: { type: string; properties?: Record<string, unknown> };
}

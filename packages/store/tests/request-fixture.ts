// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestRecord } from "@otk/store";

export function record(window: string, key = "intent"): RequestRecord {
  return {
    principal: "u",
    client_id: "client",
    intent_key: key,
    window_id: window,
    method: "tasks.create",
    fingerprint: "a".repeat(64),
    execution: "local",
    state: "queued",
    seq: 1,
    accepted_at: 10,
    updated_at: 10,
    retention_until: 300,
    dispatched_at: null,
    owner_run: null,
    scope_session: null,
    scope_directory: "/p",
    scope_resource: null,
    progress_code: null,
    progress_completed: null,
    progress_total: null,
    receipt_kind: null,
    receipt_json: null,
    error_code: null,
    error_retry: null,
    error_field: null,
    diagnostic_id: null,
  };
}

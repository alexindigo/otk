// SPDX-License-Identifier: LGPL-3.0-only
import type { FormAnswer, FormRequest } from "../forms.ts";
import type { OperationContext } from "../requests.ts";
export interface FormsCapability {
  list(
    input?: { sessionID?: string; directory?: string },
    signal?: AbortSignal,
  ): Promise<FormRequest[]>;
  reply(
    requestID: string,
    answer: FormAnswer,
    operation?: OperationContext,
  ): Promise<void>;
  cancel(
    requestID: string,
    message?: string,
    operation?: OperationContext,
  ): Promise<void>;
  /** Volatile pending authority, including location-owned forms, independent of body leases. */
  watch(listener: () => void): () => void;
}
export interface FormsCapabilities {
  forms: FormsCapability;
}

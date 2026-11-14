// SPDX-License-Identifier: LGPL-3.0-only
export interface RequestMetadata {
  readonly kind: "read" | "mutation" | "lease";
  readonly pending: string;
  /** Secondary persistence must not replace the user's still-pending action. */
  readonly presentation?: "bookkeeping";
  /** Native request class this mutation settles, identified by `requestID`.
   * One connection admits one settlement per request, from any caller. */
  readonly settles?: "permission" | "input";
}
/** Feature-owned descriptions, never execution dispatch or displayable method names. */
export class RequestMetadataRegistry {
  #items = new Map<string, RequestMetadata>();
  register(method: string, metadata: RequestMetadata): void {
    if (this.#items.has(method)) throw new Error("Duplicate request metadata");
    this.#items.set(method, Object.freeze({ ...metadata }));
  }
  get(method: string): RequestMetadata | undefined {
    return this.#items.get(method);
  }
  methods(): string[] {
    return [...this.#items.keys()];
  }
}

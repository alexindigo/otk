// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type FormAnswer,
  type FormRequest,
  type FormsCapability,
  OperationFailure,
  type PermissionRequest,
  type PermissionsCapability,
  type SessionLookup,
} from "@otk/protocol";
import { errorTag, type OpenCodeClient, type V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { mapFileDiffs, record } from "./map.ts";
import { resolve } from "@std/path";
type NativePermission = Awaited<
  ReturnType<OpenCodeClient["permission"]["request"]["list"]>
>["data"][number];
type NativeForm = Awaited<
  ReturnType<OpenCodeClient["form"]["list"]>
>["data"][number];
type Location = { directory: string; workspaceID?: string };
/** One canonical pending-request owner; routing location stays private to this adapter.
 * Every request it admits, from a live event or an inventory, is reported. */
export class V2Pending {
  #settled = new Set<string>();
  #permissions = new Map<
    string,
    {
      request: PermissionRequest;
      location: Location;
      source?: NativePermission["source"];
      details?: Promise<void>;
    }
  >();
  #forms = new Map<
    string,
    {
      request: FormRequest;
      native: string;
      location: Location;
      question?: import("@otk/protocol").QuestionRequest;
    }
  >();
  #listeners = new Set<() => void>();
  readonly permissions: PermissionsCapability;
  readonly forms: FormsCapability;
  readonly questions: import("@otk/protocol").QuestionsCapability;
  constructor(
    readonly client: () => V2Client,
    readonly entry: SessionLookup,
    readonly changed: (
      sessionID: string,
      op: import("@otk/protocol").ContentOp,
    ) => void,
    readonly observed: (
      sessionID: string,
      requestID: string,
      request: Record<string, unknown>,
    ) => void = () => {},
  ) {
    this.permissions = {
      listPermissions: async (id, signal) => {
        ids.decode(id);
        signal?.throwIfAborted();
        for (const pending of this.#permissions.values()) {
          if (
            !belongsToSession(pending.request.sessionID, id, entry) ||
            pending.request.kind !== "bash" ||
            pending.request.detail.kind !== "generic" || !pending.source
          ) continue;
          await (pending.details ??= this.#shellDetail(pending, signal).catch(
            (error) => {
              pending.details = undefined;
              throw error;
            },
          ));
        }
        signal?.throwIfAborted();
        return [...this.#permissions.values()].map((x) =>
          structuredClone(x.request)
        )
          .filter((x) => belongsToSession(x.sessionID, id, entry));
      },
      replyPermission: async (input, operation) => {
        const pending = this.#permissions.get(input.requestID);
        if (!pending) {
          return this.#requireSettlement("permission", input.requestID);
        }
        // The caller may display a root, but the request's asking identity is authoritative.
        const asking = pending.request.sessionID;
        // In native V2, feedback converts a decline into a model correction.
        const message = input.message?.trim();
        try {
          await client().effect(
            (api) =>
              api.permission.reply({
                sessionID: ids.decode(asking),
                requestID: input.requestID,
                decision: input.reply,
                ...(message ? { message } : {}),
              }),
            operation,
            [
              "PermissionNotFoundError",
              "PermissionAlreadySettledError",
              "AlreadySettledError",
            ],
          );
        } catch (error) {
          if (
            !(error instanceof OperationFailure &&
              error.outcome === "rejected" && error.facts?.status === 404)
          ) throw error;
          // A native permission 404 proves this identity is no longer answerable,
          // even if the response did not carry the SDK's tagged error envelope.
        }
        this.settle("permission", input.requestID, ids.decode(asking));
      },
    };
    this.forms = {
      list: (input = {}, signal) => {
        signal?.throwIfAborted();
        if (input.sessionID) ids.decode(input.sessionID);
        return Promise.resolve(
          [...this.#forms.values()].map((x) => structuredClone(x.request))
            .filter((x) =>
              (!input.directory || x.directory === input.directory) &&
              (!input.sessionID ||
                x.owner.kind === "session" &&
                  belongsToSession(x.owner.sessionID, input.sessionID, entry))
            ),
        );
      },
      reply: (id, answer, operation) =>
        this.#answer(id, answer, undefined, operation),
      cancel: (id, message, operation) =>
        this.#answer(id, undefined, message, operation),
      watch: (listener) => {
        this.#listeners.add(listener);
        return () => {
          this.#listeners.delete(listener);
        };
      },
    };
    this.questions = {
      listQuestions: (id, signal) => {
        ids.decode(id);
        signal?.throwIfAborted();
        return Promise.resolve(
          [...this.#forms.values()].flatMap((f) =>
            f.question && belongsToSession(f.question.sessionID, id, entry)
              ? [structuredClone(f.question)]
              : []
          ),
        );
      },
      answerQuestion: async (id, answers, operation) => {
        const pending = this.#forms.get(id);
        if (!pending?.question) return this.#requireSettlement("form", id);
        if (answers === undefined) {
          return await this.forms.cancel(id, undefined, operation);
        }
        const answer: FormAnswer = {};
        pending.request.fields.forEach((field, i) => {
          const values = answers[i]?.map((label) =>
            field.type === "string" || field.type === "multiselect"
              ? field.options?.find((option) =>
                option.label === label
              )?.value ?? label
              : label
          ) ?? [];
          if (field.type === "multiselect") {
            answer[field.key] = values;
          } else if (field.type === "string" && values.length) {
            answer[field.key] = values[0];
          }
        });
        await this.forms.reply(id, answer, operation);
      },
    };
  }
  /** Publish from retained authority when a session's recipient route changes. */
  publishOwner(sessionID: string): void {
    for (const { request } of this.#permissions.values()) {
      if (request.sessionID === sessionID) {
        this.changed(sessionID, { op: "permission.upsert", request });
      }
    }
    for (const { request, question } of this.#forms.values()) {
      if (
        request.owner.kind === "session" &&
        request.owner.sessionID === sessionID
      ) {
        this.changed(sessionID, { op: "form.upsert", request });
        if (question) {
          this.changed(sessionID, { op: "question.upsert", request: question });
        }
      }
    }
  }
  async #shellDetail(
    pending: {
      request: PermissionRequest;
      location: Location;
      source?: NativePermission["source"];
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const source = pending.source!;
    const message = await this.client().read(
      (api) =>
        api.session.message.get({
          sessionID: ids.decode(pending.request.sessionID),
          messageID: source.messageID,
        }, { signal }),
      signal,
    );
    const tool = message.type === "assistant"
      ? message.content.find((part) =>
        part.type === "tool" && part.id === source.id
      )
      : undefined;
    const input = tool?.type === "tool" ? record(tool.state.input) : {};
    signal?.throwIfAborted();
    if (
      this.#permissions.get(pending.request.id) !== pending ||
      typeof input.command !== "string"
    ) return;
    pending.request = {
      ...pending.request,
      detail: {
        kind: "bash",
        command: input.command,
        ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
      },
    };
    this.changed(pending.request.sessionID, {
      op: "permission.upsert",
      request: pending.request,
    });
  }
  async #answer(
    id: string,
    answer?: FormAnswer,
    message?: string,
    operation?: import("@otk/protocol").OperationContext,
  ): Promise<void> {
    const pending = this.#forms.get(id);
    if (!pending) return this.#requireSettlement("form", id);
    const target = { sessionID: pending.native, formID: id };
    const options = pending.native === "global"
      ? {
        headers: {
          "x-opencode-directory": encodeURIComponent(
            pending.location.directory,
          ),
        },
      }
      : undefined;
    try {
      await this.client().effect(
        (api) =>
          answer === undefined
            ? api.session.form.cancel({
              ...target,
              ...(message !== undefined ? { message } : {}),
            }, options)
            : api.session.form.reply({ ...target, answer }, options),
        operation,
      );
    } catch (error) {
      if (
        !["FormNotFoundError", "FormAlreadySettledError"].includes(
          errorTag(error) ?? "",
        )
      ) throw error;
      // Only a successful inventory can retire a stale/settled form. A failed
      // inventory leaves the retained draft and pending authority untouched.
      const rows = await this.client().read(
        (api) => api.form.list({ location: pending.location }),
        operation?.signal,
      );
      if (rows.data.some((row) => row.id === id)) throw error;
    }
    this.settle("form", id, pending.native);
  }
  #requireSettlement(kind: "permission" | "form", id: string): void {
    if (this.settled(kind, id)) return;
    const reason =
      "The pending request is not currently available. No reply was sent.";
    throw new OperationFailure(
      "unavailable",
      "pending-input.unavailable",
      new Error(reason),
      { reason },
    );
  }
  /** Explicit native settlement does not depend on the availability of another inventory. */
  settle(kind: "permission" | "form", id: string, native: string): void {
    const existing = kind === "permission"
      ? this.#permissions.get(id)?.request.sessionID
      : this.#forms.get(id)?.native;
    if (
      existing &&
      (kind === "permission" ? ids.decode(existing) : existing) !== native
    ) return;
    this.#settled.add(`${kind}:${id}`);
    this.#remove(kind, id);
  }
  /** Loaded-directory absence retires routing ownership, not native settlement.
   * A reloaded directory may report the same still-unresolved request later. */
  retainLocations(directories: ReadonlySet<string>): void {
    for (const [id, pending] of this.#permissions) {
      if (!directories.has(pending.location.directory)) {
        this.#remove("permission", id);
      }
    }
    for (const [id, pending] of this.#forms) {
      if (!directories.has(pending.location.directory)) {
        this.#remove("form", id);
      }
    }
  }
  /** Retain form payload and renderer identity, not fresh attention authority. */
  uncertain(preserve: ReadonlySet<string> = new Set()): void {
    let changed = false;
    for (const pending of this.#forms.values()) {
      if (preserve.has(pending.request.id)) continue;
      if (pending.request.fresh === false) continue;
      pending.request = { ...pending.request, fresh: false };
      changed = true;
    }
    if (changed) this.#notify();
  }
  #remove(kind: "permission" | "form", id: string): void {
    if (kind === "permission") {
      const pending = this.#permissions.get(id);
      if (!pending) return;
      this.#permissions.delete(id);
      this.changed(pending.request.sessionID, {
        op: "permission.remove",
        requestID: id,
        sessionID: pending.request.sessionID,
      });
      return;
    }
    const pending = this.#forms.get(id);
    if (!pending) return;
    this.#forms.delete(id);
    if (pending.request.owner.kind === "session") {
      this.changed(pending.request.owner.sessionID, {
        op: "form.remove",
        requestID: id,
      });
    }
    if (pending.question) {
      this.changed(pending.question.sessionID, {
        op: "question.remove",
        requestID: id,
        sessionID: pending.question.sessionID,
      });
    }
    this.#notify();
  }
  /** Local replies and stream settlements share authority over all later snapshots. */
  settled(kind: "permission" | "form", id: string): boolean {
    return this.#settled.has(`${kind}:${id}`);
  }
  retireSession(native: string): void {
    for (const [id, pending] of this.#permissions) {
      if (ids.decode(pending.request.sessionID) === native) {
        this.settle("permission", id, native);
      }
    }
    for (const [id, pending] of this.#forms) {
      if (pending.native === native) this.settle("form", id, native);
    }
  }
  replace(
    location: Location,
    permissions: readonly NativePermission[],
    forms: readonly NativeForm[],
  ): void {
    this.replacePermissions(location, permissions);
    this.replaceForms(location, forms);
  }
  replacePermissions(
    location: Location,
    permissions: readonly NativePermission[],
    preserve: ReadonlySet<string> = new Set(),
  ): void {
    for (const [key, value] of this.#permissions) {
      if (
        value.location.directory === location.directory &&
        !preserve.has(key) &&
        !permissions.some((x) => x.id === key)
      ) {
        this.settle("permission", key, ids.decode(value.request.sessionID));
      }
    }
    for (const raw of permissions) {
      if (!preserve.has(raw.id)) this.#permission(location, raw);
    }
  }
  /** Events and full inventories converge before any attention count is exposed. */
  acceptPermission(location: Location, value: unknown): boolean {
    const raw = record(value);
    if (
      typeof raw.id !== "string" || this.settled("permission", raw.id) ||
      typeof raw.sessionID !== "string" ||
      typeof raw.action !== "string" || !Array.isArray(raw.resources) ||
      !raw.resources.every((resource) => typeof resource === "string")
    ) return false;
    this.#permission(location, raw as NativePermission);
    return true;
  }
  #permission(location: Location, raw: NativePermission): void {
    if (this.settled("permission", raw.id)) return;
    const files = mapFileDiffs(raw.metadata?.files).map((file) => ({
      ...file,
      ...(file.path ? { path: resolve(location.directory, file.path) } : {}),
    }));
    const request: PermissionRequest = {
      id: raw.id,
      sessionID: ids.encode(raw.sessionID),
      kind: raw.action === "shell" ? "bash" : raw.action,
      title: raw.message ?? (raw.action === "shell" ? "bash" : raw.action),
      patterns: [...raw.resources],
      alwaysPatterns: [...raw.save ?? []],
      detail:
        raw.action === "shell" && typeof raw.metadata?.command === "string"
          ? {
            kind: "bash",
            command: raw.metadata.command,
            ...(typeof raw.metadata?.cwd === "string"
              ? { cwd: raw.metadata.cwd }
              : {}),
          }
          : files.length
          ? { kind: "edit", files }
          : {
            kind: "generic",
            summary: raw.message ?? raw.resources.join(", "),
          },
      ...(raw.source ? { toolCall: raw.source.id } : {}),
      time: this.#permissions.get(raw.id)?.request.time ?? Date.now(),
    };
    const previous = this.#permissions.get(raw.id);
    if (
      request.detail.kind === "generic" &&
      previous?.request.detail.kind === "bash" &&
      previous.source?.id === raw.source?.id &&
      previous.source?.messageID === raw.source?.messageID
    ) request.detail = previous.request.detail;
    if (
      previous && previous.request.sessionID === request.sessionID &&
      previous.source?.id === raw.source?.id &&
      previous.source?.messageID === raw.source?.messageID
    ) {
      previous.request = request;
      previous.location = location;
      previous.source = raw.source;
    } else {this.#permissions.set(raw.id, {
        request,
        location,
        source: raw.source,
      });}
    this.observed(request.sessionID, raw.id, structuredClone(raw));
    this.changed(request.sessionID, { op: "permission.upsert", request });
  }
  replaceForms(
    location: Location,
    forms: readonly NativeForm[],
    preserve: ReadonlySet<string> = new Set(),
  ): void {
    for (const [key, value] of this.#forms) {
      if (
        value.location.directory === location.directory &&
        !preserve.has(key) &&
        !forms.some((x) => x.id === key)
      ) {
        this.settle("form", key, value.native);
      }
    }
    for (const raw of forms) {
      if (!preserve.has(raw.id)) this.#form(location, raw);
    }
    this.#notify();
  }
  acceptForm(location: Location, value: unknown): boolean {
    const raw = record(value);
    if (
      typeof raw.id !== "string" || this.settled("form", raw.id) ||
      typeof raw.sessionID !== "string" ||
      !Array.isArray(raw.fields) ||
      !raw.fields.every((value) =>
        typeof record(value).key === "string" &&
        typeof record(value).type === "string"
      )
    ) return false;
    this.#form(location, raw as NativeForm);
    this.#notify();
    return true;
  }
  #form(location: Location, raw: NativeForm): void {
    if (this.settled("form", raw.id)) return;
    const fields = raw.fields.map((field) =>
      field.type === "number" || field.type === "integer"
        ? {
          ...field,
          ...(field.minimum === undefined
            ? {}
            : { minimum: Number(field.minimum) }),
          ...(field.maximum === undefined
            ? {}
            : { maximum: Number(field.maximum) }),
          ...(field.default === undefined
            ? {}
            : { default: Number(field.default) }),
        } as import("@otk/protocol").FormField
        : structuredClone(field)
    );
    const request: FormRequest = {
      id: raw.id,
      owner: raw.sessionID === "global"
        ? { kind: "location", directory: location.directory }
        : { kind: "session", sessionID: ids.encode(raw.sessionID) },
      directory: location.directory,
      title: raw.title,
      fields,
    };
    const compatible = raw.metadata?.kind === "question" &&
      raw.sessionID !== "global" &&
      fields.every((field, index) =>
        field.key === `q${index}` &&
        (field.type === "string" || field.type === "multiselect") &&
        !field.hidden && !field.when?.length
      );
    const question: import("@otk/protocol").QuestionRequest | undefined =
      compatible
        ? {
          id: raw.id,
          sessionID: ids.encode(raw.sessionID),
          questions: fields.map((field) => {
            if (
              field.type !== "string" && field.type !== "multiselect"
            ) {
              throw new Error("Invalid question projection");
            }
            return {
              header: field.title,
              text: field.description ?? field.title ?? field.key,
              options: (field.options ?? []).map((o) => ({
                label: o.label,
                description: o.description,
              })),
              multiple: field.type === "multiselect",
              custom: !!field.custom,
            };
          }),
        }
        : undefined;
    if (question) request.presentation = "question";
    const previous = this.#forms.get(raw.id);
    this.#forms.set(raw.id, {
      request,
      native: raw.sessionID,
      location,
      ...(question ? { question } : {}),
    });
    if (request.owner.kind === "session") {
      this.observed(request.owner.sessionID, raw.id, structuredClone(raw));
      this.changed(request.owner.sessionID, { op: "form.upsert", request });
    }
    if (previous?.question && !question) {
      this.changed(previous.question.sessionID, {
        op: "question.remove",
        requestID: raw.id,
        sessionID: previous.question.sessionID,
      });
    }
    if (question) {
      this.changed(question.sessionID, {
        op: "question.upsert",
        request: question,
      });
    }
  }
  clear(): void {
    this.#permissions.clear();
    this.#forms.clear();
    this.#settled.clear();
    this.#notify();
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

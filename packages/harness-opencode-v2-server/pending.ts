// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type FormAnswer,
  type FormRequest,
  type FormsCapability,
  type PermissionRequest,
  type PermissionsCapability,
  type SessionLookup,
} from "@otk/protocol";
import { errorTag, type OpenCodeClient, type V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
type NativePermission = Awaited<
  ReturnType<OpenCodeClient["permission"]["request"]["list"]>
>["data"][number];
type NativeForm = Awaited<
  ReturnType<OpenCodeClient["form"]["list"]>
>["data"][number];
type Location = { directory: string; workspaceID?: string };
/** One canonical pending-request owner; routing location stays private to this adapter. */
export class V2Pending {
  #permissions = new Map<
    string,
    { request: PermissionRequest; location: Location }
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
  ) {
    this.permissions = {
      listPermissions: (id, signal) => {
        ids.decode(id);
        signal?.throwIfAborted();
        return Promise.resolve(
          [...this.#permissions.values()].map((x) => structuredClone(x.request))
            .filter((x) => belongsToSession(x.sessionID, id, entry)),
        );
      },
      replyPermission: async (input, operation) => {
        const pending = this.#permissions.get(input.requestID);
        // The caller may display a root, but the request's asking identity is authoritative.
        const asking = pending?.request.sessionID ?? input.sessionID;
        const message = input.reply === "reject"
          ? input.message?.trim() || "The user declined this request."
          : input.message;
        await client().effect(
          (api) =>
            api.permission.reply({
              sessionID: ids.decode(asking),
              requestID: input.requestID,
              decision: input.reply,
              ...(message ? { message } : {}),
              ...(pending ? { location: pending.location } : {}),
            }),
          operation,
          [
            "PermissionNotFoundError",
            "PermissionAlreadySettledError",
            "AlreadySettledError",
          ],
        );
        this.#permissions.delete(input.requestID);
        changed(asking, {
          op: "permission.remove",
          requestID: input.requestID,
          sessionID: asking,
        });
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
        if (!pending?.question) return;
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
  async #answer(
    id: string,
    answer?: FormAnswer,
    message?: string,
    operation?: import("@otk/protocol").OperationContext,
  ): Promise<void> {
    const pending = this.#forms.get(id);
    if (!pending) return; // Already converged by a successful inventory or settlement event.
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
  /** Explicit native settlement does not depend on the availability of another inventory. */
  settle(kind: "permission" | "form", id: string, native: string): void {
    if (kind === "permission") {
      const pending = this.#permissions.get(id);
      if (!pending || ids.decode(pending.request.sessionID) !== native) return;
      this.#permissions.delete(id);
      this.changed(pending.request.sessionID, {
        op: "permission.remove",
        requestID: id,
        sessionID: pending.request.sessionID,
      });
      return;
    }
    const pending = this.#forms.get(id);
    if (!pending || pending.native !== native) return;
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
    for (const [key, value] of this.#permissions) {
      if (
        value.location.directory === location.directory &&
        !permissions.some((x) => x.id === key)
      ) {
        this.settle("permission", key, ids.decode(value.request.sessionID));
      }
    }
    for (const [key, value] of this.#forms) {
      if (
        value.location.directory === location.directory &&
        !forms.some((x) => x.id === key)
      ) {
        this.settle("form", key, value.native);
      }
    }
    for (const raw of permissions) {
      const request: PermissionRequest = {
        id: raw.id,
        sessionID: ids.encode(raw.sessionID),
        kind: raw.action === "shell" ? "bash" : raw.action,
        title: raw.message ?? raw.action,
        patterns: [...raw.resources],
        alwaysPatterns: [...raw.save ?? []],
        detail:
          raw.action === "shell" && typeof raw.metadata?.command === "string"
            ? {
              kind: "bash",
              command: raw.metadata.command,
              cwd: location.directory,
            }
            : {
              kind: "generic",
              summary: raw.message ?? raw.resources.join(", "),
            },
        ...(raw.source ? { toolCall: raw.source.id } : {}),
        time: this.#permissions.get(raw.id)?.request.time ?? Date.now(),
      };
      this.#permissions.set(raw.id, { request, location });
      this.changed(request.sessionID, { op: "permission.upsert", request });
    }
    for (const raw of forms) {
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
        raw.sessionID !== "global" && fields.every((field, index) =>
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
      this.#forms.set(raw.id, {
        request,
        native: raw.sessionID,
        location,
        ...(question ? { question } : {}),
      });
      if (request.owner.kind === "session") {
        this.changed(request.owner.sessionID, { op: "form.upsert", request });
      }
      if (question) {
        this.changed(question.sessionID, {
          op: "question.upsert",
          request: question,
        });
      }
    }
    this.#notify();
  }
  clear(): void {
    this.#permissions.clear();
    this.#forms.clear();
    this.#notify();
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

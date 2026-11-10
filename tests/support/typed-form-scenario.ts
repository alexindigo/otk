// SPDX-License-Identifier: LGPL-3.0-only
import type { FormAnswer, FormRequest, FormsCapability } from "@otk/protocol";
import { OperationFailure } from "@otk/protocol";
import { coreBackendFixture } from "./core-backend.ts";
import { fixture } from "./config.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import type { ControlRequest, TestLease } from "./fixture-control.ts";
export async function typedFormScenario() {
  const root = await fixture(),
    id = "tstv1-forms",
    listeners = new Set<() => void>();
  const sessionForm: FormRequest = {
    id: "typed-session",
    owner: { kind: "session", sessionID: id },
    directory: root,
    title: "Configure deployment",
    fields: [
      {
        key: "name",
        title: "Deployment name",
        type: "string",
        required: true,
        minLength: 2,
        placeholder: "Name",
      },
      {
        key: "mode",
        title: "Mode",
        type: "string",
        custom: true,
        options: [{ value: "now", label: "Deploy now" }, {
          value: "later",
          label: "Schedule later",
        }],
        default: "now",
      },
      {
        key: "rate",
        title: "Traffic fraction",
        type: "number",
        minimum: 0,
        maximum: 1,
        required: true,
      },
      {
        key: "count",
        title: "Instances",
        type: "integer",
        minimum: 1,
        maximum: 10,
        required: true,
      },
      {
        key: "enabled",
        title: "Enable deployment",
        type: "boolean",
        required: true,
      },
      {
        key: "regions",
        title: "Regions",
        type: "multiselect",
        options: [{ value: "west", label: "West region" }, {
          value: "east",
          label: "East region",
        }],
        custom: true,
        minItems: 1,
      },
      {
        key: "conditional",
        title: "Release note",
        type: "string",
        when: [{ key: "enabled", op: "eq", value: true }],
      },
      {
        key: "hidden",
        title: "Environment",
        type: "string",
        hidden: true,
        required: true,
        default: "staging",
      },
      {
        key: "external",
        title: "Verify deployment access",
        description:
          "Complete the external verification, then acknowledge it here.",
        type: "external",
        url: "https://example.com/verify",
      },
    ],
  };
  const globalForm: FormRequest = {
    ...sessionForm,
    id: "typed-global",
    title: "Connect project account",
    owner: { kind: "location", directory: root },
    fields: [{
      key: "account",
      title: "Account",
      type: "string",
      default: "Project account",
    }, {
      key: "verify",
      title: "Authorize account access",
      description: "This request belongs to the project, not to a session.",
      type: "external",
      url: "https://example.com/authorize",
    }],
  };
  let pending = [sessionForm], fail = false, lease: TestLease | undefined;
  const received: FormAnswer[] = [], cancelled: (string | undefined)[] = [];
  const notify = () => {
    for (const listener of listeners) listener();
    if (f) {
      const entry = f.app.index.get(id)!;
      f.app.index.upsertMetadata({
        ...entry,
        attention: {
          ...entry.attention,
          questions: pending.filter((r) => r.owner.kind === "session").length,
        },
      });
    }
  };
  const capability: FormsCapability = {
    list: (input) =>
      Promise.resolve(
        pending.filter((r) =>
          !input?.sessionID ||
          r.owner.kind === "session" && r.owner.sessionID === input.sessionID
        ),
      ),
    watch: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reply: (requestID, answer) => {
      received.push(answer);
      if (fail) {
        fail = false;
        return Promise.reject(
          new OperationFailure(
            "rejected",
            "native.rejected",
            new Error("The native form rejected this answer"),
          ),
        );
      }
      pending = pending.filter((r) => r.id !== requestID);
      notify();
      return Promise.resolve();
    },
    cancel: (requestID, message) => {
      cancelled.push(message);
      pending = pending.filter((r) => r.id !== requestID);
      notify();
      return Promise.resolve();
    },
  };
  const f = await coreBackendFixture(root, { forms: capability }, id);
  notify();
  const c = new WsClient(f.url);
  await c.connect();
  resources().defer("typed form controller", () => c.close());
  await c.rpc("prefs.set", { key: "animationsOff", value: true });
  const baseline = await c.rpc<
    Record<string, import("./fixture-control.ts").Json>
  >("prefs.get", {});
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign form lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "stop":
          await c.close();
          await f.app.stop();
          return null;
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "observe":
          return { received, cancelled, pending, sessionID: id };
        case "scenario":
          if (frame.params.action === "hold") pending = [globalForm];
          else if (frame.params.action === "fail") fail = true;
          else if (frame.params.action === "succeed") pending = [sessionForm];
          else throw new Error("Unsupported form action");
          notify();
          return null;
        default:
          throw new Error("Unsupported typed form command");
      }
    },
  };
}

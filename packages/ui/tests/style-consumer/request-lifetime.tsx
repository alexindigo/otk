// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup } from "solid-js";
import { CommandHub, RequestLifetimes } from "@otk/client";
import {
  DEFAULT_PREFS,
  type FormRequest,
  type PermissionRequest,
  type QuestionRequest,
} from "@otk/protocol";
import { createUiRegistries, UiProvider } from "../../registries/context.tsx";
import {
  type SessionPorts,
  SessionProvider,
} from "../../registries/session.tsx";
import { registerQuestionTakeover } from "../../components/QuestionDock.tsx";
import { registerPermissionTakeover } from "../../components/PermissionDock.tsx";
import { registerFormTakeover } from "../../components/FormDock.tsx";
import ComposerTakeovers from "../../components/ComposerTakeovers.tsx";
import "./request-lifetime.css" with { type: "text" };
import { CommandProvider } from "../../keyboard/context.tsx";
import { registerAttentionCommands } from "../../shell/commands/attention.ts";
export default function RequestLifetimeScene() {
  const kind = new URL(location.href).searchParams.get("kind") ?? "question";
  const [dirty, setDirty] = createSignal(false);
  const [revision, setRevision] = createSignal(0),
    [connected, setConnected] = createSignal(true),
    [sent, setSent] = createSignal(0),
    [inventoryFailed, failInventory] = createSignal(false);
  const owner = new RequestLifetimes();
  onCleanup(owner.subscribe(() => setRevision((value) => value + 1)));
  const q: QuestionRequest = {
    id: "input",
    sessionID: "child",
    questions: [{
      header: "Pick",
      text: "Choose A",
      options: [{ label: "A" }],
      multiple: false,
      custom: true,
    }],
  };
  const p: PermissionRequest = {
    id: "permission",
    sessionID: "child",
    kind: "bash",
    title: "Probe",
    detail: { kind: "bash", command: "echo probe" },
    patterns: ["echo probe"],
    alwaysPatterns: [],
    time: 1,
  };
  const f: FormRequest = {
    id: "input",
    owner: { kind: "session", sessionID: "child" },
    title: "Probe form",
    directory: "/repo",
    fields: [{ key: "value", type: "string", title: "Value" }],
  };
  owner.receive(
    kind === "permission"
      ? { op: "permission.upsert", request: p }
      : kind === "form"
      ? { op: "form.upsert", request: f }
      : { op: "question.upsert", request: q },
  );
  const entry = (id: string) => ({
    id,
    title: id,
    parentID: id === "child" ? "root" : undefined,
  });
  const rpc = Promise.withResolvers<void>();
  const send = () => {
    setSent((value) => value + 1);
    return rpc.promise;
  };
  const commands = new CommandHub();
  registerAttentionCommands(commands, { permission: send, question: send });
  const ports: SessionPorts = {
    requests: owner,
    supports: () => true,
    connected,
    sessionID: () => "root",
    entry: entry as SessionPorts["entry"],
    permissions: () => {
      revision();
      return owner.permissions("root", entry, true);
    },
    questions: () => {
      revision();
      return owner.questions("root", entry, true);
    },
    forms: () => {
      revision();
      return owner.forms("root", entry, true);
    },
    prefs: () => DEFAULT_PREFS,
    dirty: (_owner, value) => setDirty(value),
    rpc: send as SessionPorts["rpc"],
    directory: () => Promise.resolve("/repo"),
    act: (action) => action(),
    submit: (action) => action(),
    history: () => Promise.resolve([]),
    attachments: (parts) => Promise.resolve(parts),
  };
  const registries = createUiRegistries();
  registerQuestionTakeover(registries.takeovers);
  registerPermissionTakeover(registries.takeovers);
  registerFormTakeover(registries.takeovers);
  return (
    <section
      class="request-lifetime-scene"
      data-sent={sent()}
      data-dirty={String(dirty())}
      data-pending={owner.permissions().length + owner.questions().length +
        owner.forms().length}
      data-inventory-failed={inventoryFailed()}
    >
      <div
        class="request-lifetime-controls"
        role="group"
        aria-label="External request controls"
      >
        <button type="button" onClick={() => setConnected(false)}>
          Disconnect
        </button>
        <button
          type="button"
          onClick={() => {
            setConnected(true);
            failInventory(true);
          }}
        >
          Reconnect with failed inventory
        </button>
        <button
          type="button"
          onClick={() => owner.retireSessions((id) => id === "child")}
        >
          Delete child
        </button>
        <button
          type="button"
          onClick={() => {
            owner.retire(
              kind === "permission" ? "permission" : "form",
              kind === "permission" ? "permission" : "input",
              "settled-remotely",
              "answered elsewhere",
            );
            rpc.resolve();
          }}
        >
          Remove request
        </button>
      </div>
      <div class="request-lifetime-preview">
        <CommandProvider commands={commands}>
          <UiProvider registries={registries}>
            <SessionProvider ports={ports}>
              <ComposerTakeovers>
                {() => <textarea aria-label="Normal composer" />}
              </ComposerTakeovers>
            </SessionProvider>
          </UiProvider>
        </CommandProvider>
      </div>
    </section>
  );
}

// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup, Show } from "solid-js";
import { RequestTracker, Rpc } from "@otk/client";
import {
  DEFAULT_PREFS,
  type PermissionRequest,
  type QuestionRequest,
} from "@otk/protocol";
import {
  type SessionPorts,
  SessionProvider,
} from "../../registries/session.tsx";
import { bindFeedback } from "../../state/feedback.ts";
import ComposerNotice from "../../components/ComposerNotice.tsx";
import OperationFeedback from "../../components/OperationFeedback.tsx";
import PermissionDock from "../../components/PermissionDock.tsx";
import QuestionDock from "../../components/QuestionDock.tsx";
import FormDock from "../../components/FormDock.tsx";

/** Controlled remount consumer: real client admission/feedback and shipped docks. */
export default function SettlementConflicts() {
  const kind = new URL(location.href).searchParams.get("kind") ?? "permission";
  const sessionID = "tstv1-settlement-fixture";
  const requestID = "already-admitted-request";
  const [sent, setSent] = createSignal(0);
  const tracker = new RequestTracker({
    send: (frame) => {
      if (frame.t === "request") setSent((value) => value + 1);
    },
    sidecarId: "remote",
    sessionTitle: () => "Reply target",
  });
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 },
    4,
  );
  const rpc = new Rpc(() => {}, tracker);
  const feedback = rpc.feedback(sessionID);
  const current = bindFeedback(() => feedback);
  const options = { owner: sessionID };
  if (kind === "permission") {
    rpc.start(
      "permission.reply",
      { requestID, sessionID, reply: "once" },
      options,
    );
  } else if (kind === "question") {
    rpc.start("question.reply", { requestID, answers: [["A"]] }, options);
  } else {
    rpc.start("form.reply", { requestID, answer: { choice: "A" } }, options);
  }
  onCleanup(() => tracker.stop());
  const ports: SessionPorts = {
    supports: () => true,
    connected: () => true,
    rpc: (method, params, input) => rpc.call(method, params, input),
    feedback,
    sessionID: () => sessionID,
    failureTarget: () => ({
      sidecarId: "remote",
      sessionID,
      label: "Reply target",
    }),
    directory: () => Promise.resolve("/fixture"),
    entry: () => undefined,
    permissions: () => [],
    questions: () => [],
    prefs: () => DEFAULT_PREFS,
    dirty() {},
    act: (action) => action(),
    submit: (action) => action(),
    history: () => Promise.resolve([]),
    attachments: (parts) => Promise.resolve(parts),
  };
  const notice = () => (
    <ComposerNotice>
      <Show when={current()}>
        {(value) => <OperationFeedback feedback={value()} />}
      </Show>
    </ComposerNotice>
  );
  const permission: PermissionRequest = {
    id: requestID,
    sessionID,
    kind: "bash",
    title: "Permission response fixture",
    patterns: ["printf fixture"],
    alwaysPatterns: ["printf *"],
    detail: { kind: "bash", command: "printf fixture", cwd: "/fixture" },
    time: 1794542400000,
  };
  const question: QuestionRequest = {
    id: requestID,
    sessionID,
    questions: [{
      header: "Choice",
      text: "Choose a response",
      options: [{ label: "A" }, { label: "B" }],
      multiple: false,
      custom: false,
    }],
  };
  return (
    <section data-settlement-frames={sent()}>
      <h2>Another {kind} response was already sent</h2>
      <p>
        A fresh view attempts a different response; the first reply remains
        pending.
      </p>
      <SessionProvider ports={ports}>
        {kind === "permission"
          ? (
            <PermissionDock
              request={permission}
              notice={notice}
              onDirty={() => {}}
              onReply={(input) =>
                rpc.call("permission.reply", input, options).then(() => {})}
            />
          )
          : kind === "question"
          ? (
            <QuestionDock
              request={question}
              notice={notice}
              onDirty={() => {}}
              onReply={(id, answers) =>
                answers
                  ? rpc.call(
                    "question.reply",
                    { requestID: id, answers },
                    options,
                  ).then(() => {})
                  : rpc.call("question.reject", { requestID: id }, options)
                    .then(() => {})}
            />
          )
          : (
            <FormDock
              request={{
                id: requestID,
                owner: { kind: "session", sessionID },
                directory: "/fixture",
                title: "Form response fixture",
                fields: [{
                  key: "choice",
                  type: "string",
                  title: "Choice",
                  default: "A",
                }],
              }}
              failureTarget={ports.failureTarget!()}
              connected
              onReply={(answer) =>
                rpc.call("form.reply", { requestID, answer }, options).then(
                  () => {},
                )}
              onCancel={() =>
                rpc.call("form.cancel", { requestID }, options).then(() => {})}
            />
          )}
      </SessionProvider>
    </section>
  );
}

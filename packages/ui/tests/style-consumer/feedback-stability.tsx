// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Show } from "solid-js";
import { createDrafts, createSessionRename, RequestFailure } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import {
  type SessionPorts,
  SessionProvider,
} from "../../registries/session.tsx";
import Form, { FormInput } from "../../components/Form.tsx";
import Dialog from "../../components/surface/Dialog.tsx";
import ListRow from "../../components/ListRow.tsx";
import TitleEditor, { TitleFeedback } from "../../components/TitleEditor.tsx";
import Prompt from "../../components/Prompt.tsx";
import AuthColumn from "../../components/AuthColumn.tsx";
import { solidState } from "../../state/binding.ts";
import NoticeLifetime from "./notice-lifetime.tsx";
import "./feedback-stability.css" with { type: "text" };
import "../../shell/Shell.css" with { type: "text" };

const reason =
  "The requested change was refused. Your input is kept. Review the target and try again when it is available. END OF REASON";
function failure(field?: string) {
  return new RequestFailure({
    code: "fixture.feedback-rejected",
    retry: "new-intent",
    diagnosticID: "feedback-stability",
    ...(field ? { field } : {}),
    facts: {
      action: "Saving task",
      target: { label: "Retained task" },
      reason,
    },
  });
}

function FormScene(props: { auth?: boolean }) {
  const [open, setOpen] = createSignal(true);
  let settled: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  styleTest.fieldFailure = (name) =>
    settled?.reject(failure(name || undefined));
  const form = () => (
    <Form
      title="Task"
      submitLabel="Save task"
      onSubmit={() => {
        settled = Promise.withResolvers<void>();
        return settled.promise;
      }}
    >
      <label>
        Name<FormInput name="taskName" value="Retained task name" />
      </label>
      <label>
        Description<FormInput name="description" value="Retained description" />
      </label>
    </Form>
  );
  if (props.auth) {
    return (
      <section class="feedback-stability-bottom">
        <div class="otk-auth-view">
          <AuthColumn title="Sign in">{form()}</AuthColumn>
        </div>
      </section>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>New task</button>
      <Show when={open()}>
        <Dialog
          id="feedback-stability"
          title="New task"
          size="form"
          onClose={() => setOpen(false)}
        >
          {form()}
        </Dialog>
      </Show>
    </>
  );
}

function InlineScene() {
  let settled: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const owner = createSessionRename({
    factory: solidState,
    rename() {
      settled = Promise.withResolvers<void>();
      return settled.promise;
    },
  });
  owner.start({
    sidecarId: "local",
    sessionID: "tstv1-stability",
    title: "Original task",
  }, "row");
  styleTest.fieldFailure = () => settled?.reject(failure());
  return (
    <section aria-label="Session name" class="feedback-stability-inline">
      <h2>Rename session</h2>
      <ListRow
        as="div"
        selected
        editing
        feedback={<TitleFeedback owner={owner} id="rename-feedback" />}
        trailing={<button type="button">Session actions</button>}
      >
        <TitleEditor owner={owner} feedbackID="rename-feedback" />
      </ListRow>
    </section>
  );
}

function StandaloneScene() {
  const drafts = createDrafts(solidState), write = drafts.writer("standalone");
  let settled: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  styleTest.fieldFailure = () => settled?.reject(failure());
  const ports: SessionPorts = {
    supports: () => true,
    rpc: () => Promise.reject(new Error("No RPC expected")),
    sessionID: () => "tstv1-standalone",
    directory: () => Promise.resolve("/project"),
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
  return (
    <section class="feedback-stability-bottom" aria-label="Standalone composer">
      <div class="feedback-stability-transcript">
        <h2>Task conversation</h2>
      </div>
      <SessionProvider ports={ports}>
        <Prompt
          value={drafts.get("standalone")}
          connected
          onChange={write}
          onSubmit={() => {
            settled = Promise.withResolvers<void>();
            return settled.promise;
          }}
          onAbort={() =>
            Promise.resolve()}
        />
      </SessionProvider>
    </section>
  );
}

export default function FeedbackStability() {
  const surface = new URL(location.href).searchParams.get("surface");
  return surface === "dialog"
    ? <FormScene />
    : surface === "auth"
    ? <FormScene auth />
    : surface === "inline"
    ? <InlineScene />
    : surface === "standalone"
    ? <StandaloneScene />
    : <NoticeLifetime structured />;
}

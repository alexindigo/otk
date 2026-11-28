// SPDX-License-Identifier: LGPL-3.0-only
import OperationFeedback from "./OperationFeedback.tsx";
import ComposerNotice from "./ComposerNotice.tsx";
import { createPrimaryAction } from "@otk/client";
import PrimaryAction from "./PrimaryAction.tsx";
import { bindPrimaryAction } from "../state/primary-action.ts";
import "./QuestionDock.css" with { type: "text" };
import Takeover from "./surface/Takeover.tsx";
import Tabs from "./Tabs.tsx";
import QuestionAnswers from "./QuestionAnswers.tsx";
import { FormChoices } from "./FormField.tsx";
import type { DockRegistry } from "../registries/renderers.ts";
export function registerQuestionDock(docks: DockRegistry): void {
  docks.register({
    id: "questions",
    capability: "questions",
    render: (inputs) => inputs.questions,
  });
}
import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import type { QuestionRequest } from "@otk/protocol";
import { createQuestionForm, type QuestionResponse } from "@otk/client";
import { solidState } from "../state/binding.ts";
import TakeoverHeader from "./TakeoverHeader.tsx";
import RequestDismiss from "./RequestDismiss.tsx";
import { bindDirtyInput } from "../state/dirty-input.ts";
import { useSessionPorts } from "../registries/session.tsx";
import type {
  SurfaceRegistry,
  TakeoverDefinition,
} from "../registries/shell.ts";
export function registerQuestionTakeover(
  registry: SurfaceRegistry<TakeoverDefinition>,
): void {
  registry.register({
    id: "questions",
    capability: "questions",
    component: QuestionTakeover,
    active: (session) => session.questions().length > 0,
  });
}
function QuestionTakeover(
  props: { notice?: () => import("solid-js").Element; focusNotice?(): void } =
    {},
) {
  const session = useSessionPorts(), { commands } = useCommandPorts();
  const request = () => session.questions()[0];
  return (
    <QuestionDock
      notice={props.notice}
      focusNotice={props.focusNotice}
      request={request()}
      where={request()
        ? session.location?.(request()!.sessionID) ??
          session.entry(request()!.sessionID)?.title
        : undefined}
      childTitle={request()?.sessionID !== session.sessionID()
        ? session.entry(request()?.sessionID ?? "")?.title
        : undefined}
      onDirty={(value, input) => session.dirty("questions", value, input)}
      onDismiss={session.requests && (() => {
        const current = request();
        if (!current) return;
        session.requests!.dismiss("question", current.id);
      })}
      onReply={(requestID, answers) =>
        commands.run("question.reply", {
          requestID,
          ...(answers ? { answers } : {}),
        })}
    />
  );
}
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
/**
 * View of one question request. All answer logic lives in `createQuestionForm`;
 * this renders its state and forwards intents. View-only state: collapse,
 * keyboard focus movement.
 */
function Request(
  props: {
    request: QuestionRequest;
    notice?: () => import("solid-js").Element;
    focusNotice?(): void;
    childTitle?: string;
    where?: string;
    onReply(id: string, answers?: string[][]): Promise<void>;
    onDismiss?(): void;
    onDirty(value: boolean, input?: string): void;
  },
) {
  const session = useSessionPorts();
  const form = createQuestionForm(props.request, solidState, session?.requests);
  bindDirtyInput(() => ({
    dirty: form.state.drafts.some((draft) =>
      !!draft.own || draft.ownChosen || draft.picked.length > 0
    ),
    text: form.answers().map((answer) => answer.join(", ")).join("\n"),
  }), (dirty, text) => props.onDirty(dirty, text));
  const [collapsed, setCollapsed] = createSignal(false);
  const [response, setResponse] = createSignal<QuestionResponse>();
  createEffect(() => props.request.id, (id) => {
    const update = () => setResponse(session.questionResponse?.(id));
    update();
    return session.observeQuestionResponse?.(update);
  });
  const pending = () => response()?.state === "sending";
  const feedback = () => {
    const state = response();
    if (!state?.feedback) return;
    return state.state === "failed" && state.canResend
      ? {
        ...state.feedback,
        action: {
          label: "Retry response",
          run: () => void reply(state.answers?.map((answer) => [...answer])),
        },
      }
      : state.feedback;
  };
  let card!: HTMLElement,
    advance!: HTMLButtonElement,
    noticeControl: { focus(): void } | undefined,
    alive = true;
  const rowRefs: HTMLElement[][] = form.questions.map(() => []);
  const ownFields: HTMLTextAreaElement[] = [];
  const step = () => form.state.step;
  const onReview = () => step() === form.review;
  const answers = () =>
    form.questions.map((question, index) => ({
      question: question.header || question.text,
      answer:
        ((pending() ? response()?.answers : form.answers())?.[index]?.join(
          ", ",
        )) || "(not answered)",
    }));
  createEffect(
    () => pending(),
    (value, previous) => {
      if (previous === false && value) {
        onSettled(() => noticeControl?.focus());
      }
    },
  );
  const reply = async (answers?: string[][]) => {
    if (pending() || !primary.permitted()) return;
    await props.onReply(props.request.id, answers).catch(() => {
      // The request owns its failure. Never publish a mounted copy.
    });
  };
  const submit = () => primary.invoke("submit");
  const ports = useCommandPorts();
  const reject = ownedCommand(ports, {
    id: "question.reject",
    title: "Reject question",
    category: "Attention",
    enabled: () => !pending(),
    run: () => reply(undefined),
  });
  // Escape leaves the answer field, then dismisses locally without replying.
  const close = ownedCommand(ports, {
    id: "question.close",
    title: "Close question layer",
    category: "Attention",
    run: () => {
      if (
        document.activeElement instanceof HTMLTextAreaElement &&
        session?.connected?.() !== false
      ) {
        focusCurrent(true);
      } else if (props.onDismiss) props.onDismiss();
      else return reject();
    },
  });
  const primary = createPrimaryAction<"answer" | "submit">({
    label: () => "Answer",
    unavailable: () =>
      !alive
        ? "Question is no longer active"
        : session?.connected?.() === false
        ? "Reconnect to answer"
        : undefined,
    pending,
    pendingReason: "Sending answer",
    run: (intent) =>
      intent === "submit" || onReview() ? reply(form.answers()) : form.next(),
  });
  const primaryState = bindPrimaryAction(primary);
  const answer = ownedCommand(ports, {
    id: "question.answer",
    title: "Answer question",
    category: "Attention",
    enabled: () => primaryState().available,
    run: () => primary.invoke("answer"),
  });
  const goTo = (target: number) => {
    form.goTo(target);
    setCollapsed(false);
  };
  // One projection for every step/collapse transition, after DOM visibility has
  // settled. Arrival itself does not move focus into an answer action.
  const rows = () => rowRefs[step()]?.filter((row) => row.isConnected) ?? [];
  const focus = (row: HTMLElement) =>
    (row instanceof HTMLButtonElement ? row : ownFields[step()])?.focus();
  const focusCurrent = (action = false) => {
    // Collapsing keeps native focus on the persistent header control. The
    // question owns every row reference; Tabs owns its own panel DOM.
    if (collapsed()) return;
    focus(action || onReview() ? advance : rows()[0] ?? advance);
  };
  createEffect(
    () => ({ step: step(), collapsed: collapsed() }),
    (value, previous) => {
      if (
        previous &&
        (value.step !== previous.step || value.collapsed !== previous.collapsed)
      ) {
        focusCurrent();
      }
    },
  );
  onSettled(() => {
    const release = ports.keyboard?.layer(
      "question.close",
      () => card.contains(document.activeElement),
      20,
    );
    return () => {
      release?.();
      alive = false;
    };
  });
  // Keyboard: move DOM focus between the active panel's rows; keys map to intents.
  const focusRow = (delta: number) => {
    const list = rows();
    if (!list.length) return;
    const at = list.findIndex((row) => row.contains(document.activeElement));
    const next = list[(at + delta + list.length) % list.length];
    focus(next);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void close();
      return;
    }
    if (pending()) return;
    const typing = event.target instanceof HTMLTextAreaElement;
    const key = event.key;
    if (typing) {
      if (key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        focusCurrent(true);
      }
      return;
    }
    const q = form.questions[step()];
    const handled = (() => {
      if (["ArrowDown", "j"].includes(key)) focusRow(1);
      else if (["ArrowUp", "k"].includes(key)) focusRow(-1);
      else if (["ArrowLeft", "h"].includes(key)) goTo(step() - 1);
      else if (["ArrowRight", "l"].includes(key)) goTo(step() + 1);
      else if (q && /^[1-9]$/.test(key)) {
        const index = Number(key) - 1;
        if (index < q.options.length) form.pick(step(), index);
        else if (index === q.options.length && q.custom) form.chooseOwn(step());
        else return false;
      } else if (key === "Enter" && event.target === card) void answer();
      else return false;
      return true;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const questionPanel = (index: number) => {
    const q = form.questions[index];
    return (
      <>
        <p class="otk-question-text">
          {q.text}
          {q.multiple ? " (select all that apply)" : ""}
        </p>
        <FormChoices
          options={q.options.map((option) => ({
            ...option,
            value: option.label,
          }))}
          selected={(value) => form.state.drafts[index].picked.includes(value)}
          onPick={(option) => form.pick(index, option)}
          custom={q.custom}
          multiple={q.multiple}
          own={form.state.drafts[index].own}
          ownChosen={form.isOwnChosen(index)}
          onOwn={() => form.chooseOwn(index)}
          onText={(text) => form.typeOwn(index, text)}
          row={(element, option) => {
            rowRefs[index][option] = element;
          }}
          input={(element) => {
            ownFields[index] = element;
          }}
        />
      </>
    );
  };
  return (
    <section
      class="otk-question-dock"
      tabindex="-1"
      aria-label="Pending question"
      ref={(el) => {
        card = el;
      }}
      onKeyDown={onKey}
    >
      <Takeover
        notice={feedback()
          ? () => (
            <ComposerNotice>
              <Show when={feedback()}>
                {(value) => (
                  <OperationFeedback
                    feedback={value()}
                    control={(control) => noticeControl = control}
                  />
                )}
              </Show>
            </ComposerNotice>
          )
          : props.notice}
        collapsed={collapsed()}
        title={
          <TakeoverHeader
            entityKey={`session:${props.request.sessionID}`}
            title="The agent asks"
            where={props.where}
            childTitle={props.childTitle}
            collapsed={collapsed()}
            onCollapse={setCollapsed}
          />
        }
        actions={() => (
          <div class="otk-question-actions">
            <PrimaryAction
              state={primaryState()}
              class="otk-primary otk-pill"
              ref={(element) => {
                advance = element;
              }}
              onInvoke={() => void answer()}
              title={onReview() ? "Send the answers" : "Next step"}
            />
            <button
              type="button"
              class="otk-pill"
              hidden={pending()}
              onClick={() => void reject()}
              title="Reject this question without answering"
            >
              Skip question
            </button>
            <button
              type="button"
              class="otk-pill otk-question-submit"
              hidden={pending()}
              onClick={() => void submit()}
              title="Send the answers given so far"
            >
              Submit
            </button>
            <RequestDismiss onDismiss={props.onDismiss} />
          </div>
        )}
      >
        <Show
          when={!pending()}
          fallback={<QuestionAnswers items={answers()} />}
        >
          <Show
            when={!collapsed()}
            fallback={
              <p class="otk-question-text otk-question-peek">
                {onReview()
                  ? "Review your answers"
                  : form.questions[step()]?.text}
              </p>
            }
          >
            <Tabs
              label="Questions"
              tabs={[
                ...form.questions.map((q, index) => ({
                  label: q.header || `Question ${index + 1}`,
                  panel: () => questionPanel(index),
                })),
                {
                  label: "Confirm",
                  panel: () => <QuestionAnswers items={answers()} />,
                },
              ]}
              selected={step()}
              onSelect={goTo}
            />
          </Show>
        </Show>
      </Takeover>
    </section>
  );
}
export default function QuestionDock(
  props: {
    request?: QuestionRequest;
    notice?: () => import("solid-js").Element;
    focusNotice?(): void;
    childTitle?: string;
    where?: string;
    onReply(id: string, answers?: string[][]): Promise<void>;
    onDismiss?(): void;
    onDirty(value: boolean, input?: string): void;
  },
): import("solid-js").Element {
  return (
    <For each={props.request ? [props.request] : []} keyed={(q) => q.id}>
      {(q) => (
        <Request
          notice={props.notice}
          focusNotice={props.focusNotice}
          request={q()}
          childTitle={props.childTitle}
          where={props.where}
          onReply={props.onReply}
          onDismiss={props.onDismiss}
          onDirty={props.onDirty}
        />
      )}
    </For>
  );
}

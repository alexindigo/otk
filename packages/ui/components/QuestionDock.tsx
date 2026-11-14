// SPDX-License-Identifier: LGPL-3.0-only
import FeedbackStatus from "./FeedbackStatus.tsx";
import { bindFeedback } from "../state/feedback.ts";
import {
  createPrimaryAction,
  errorFeedback,
  type FailureValue,
  failureValue,
} from "@otk/client";
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
import { createQuestionForm, forgetQuestionForm } from "@otk/client";
import { solidState } from "../state/binding.ts";
import TakeoverHeader from "./TakeoverHeader.tsx";
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
 * reply progress, keyboard focus movement.
 */
function Request(
  props: {
    request: QuestionRequest;
    notice?: () => import("solid-js").Element;
    focusNotice?(): void;
    childTitle?: string;
    where?: string;
    onReply(id: string, answers?: string[][]): Promise<void>;
    onDirty(value: boolean, input?: string): void;
  },
) {
  const form = createQuestionForm(props.request, solidState);
  const session = useSessionPorts();
  const feedback = session?.feedback;
  const operation = bindFeedback(() => feedback);
  const [collapsed, setCollapsed] = createSignal(false),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal<FailureValue>("");
  let card!: HTMLElement,
    advance!: HTMLButtonElement,
    pendingStatus!: HTMLDivElement,
    alive = true;
  const rowRefs: HTMLElement[][] = form.questions.map(() => []);
  const ownFields: HTMLTextAreaElement[] = [];
  const step = () => form.state.step;
  const onReview = () => step() === form.review;
  const answers = () =>
    form.questions.map((question, index) => ({
      question: question.header || question.text,
      answer: form.answers()[index].join(", ") || "(not answered)",
    }));
  createEffect(
    () => ({ pending: pending(), feedback: operation() }),
    (value) => {
      if (value.pending) {
        onSettled(() => {
          if (props.focusNotice && value.feedback) props.focusNotice();
          else pendingStatus?.focus();
        });
      }
    },
  );
  const reply = async (answers?: string[][]) => {
    if (pending() || !primary.permitted()) return;
    setPending(true);
    feedback?.clear();
    setError("");
    try {
      await props.onReply(props.request.id, answers);
      forgetQuestionForm(props.request.id);
      props.onDirty(false);
    } catch (failure) {
      if (feedback) feedback.fail(failure);
      else if (alive) {
        setError(
          failureValue(failure, { action: "Sending question response" }),
        );
      }
    } finally {
      if (alive) setPending(false);
    }
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
  // Escape goes through the keyboard layer: leave the answer field, else skip.
  ownedCommand(ports, {
    id: "question.close",
    title: "Close question layer",
    category: "Attention",
    run: () => {
      if (document.activeElement instanceof HTMLTextAreaElement) {
        focusCurrent(true);
      } else return reject();
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
    const stopDirty = form.subscribe(() =>
      props.onDirty(
        true,
        form.answers().map((answer) => answer.join(", ")).join("\n"),
      )
    );
    const release = ports.keyboard?.layer(
      "question.close",
      () => card.contains(document.activeElement),
      20,
    );
    return () => {
      stopDirty();
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
        notice={props.notice}
        collapsed={collapsed()}
        title={
          <TakeoverHeader
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
            <Show when={pending() && !(props.focusNotice && operation())}>
              <FeedbackStatus
                ref={(element) => pendingStatus = element}
                focusable
                feedback={{ kind: "pending", text: "Sending answer..." }}
              />
            </Show>
            <button
              type="button"
              class="otk-pill"
              hidden={pending()}
              onClick={() => void reject()}
              title="Skip question (Esc with question controls focused)"
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
        <Show when={error()}>
          <FeedbackStatus feedback={errorFeedback(error())} />
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
          onDirty={props.onDirty}
        />
      )}
    </For>
  );
}

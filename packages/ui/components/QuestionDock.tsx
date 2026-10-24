// SPDX-License-Identifier: LGPL-3.0-only
import "./QuestionDock.css" with { type: "text" };
import ContentTextarea from "./ContentTextarea.tsx";
import Takeover from "./surface/Takeover.tsx";
import Tabs from "./Tabs.tsx";
import QuestionAnswers from "./QuestionAnswers.tsx";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
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
function QuestionTakeover() {
  const session = useSessionPorts(), { commands } = useCommandPorts();
  const request = () => session.questions()[0];
  return (
    <QuestionDock
      request={request()}
      where={request()
        ? session.location?.(request()!.sessionID) ??
          session.entry(request()!.sessionID)?.title
        : undefined}
      childTitle={request()?.sessionID !== session.sessionID()
        ? session.entry(request()?.sessionID ?? "")?.title
        : undefined}
      onDirty={(value) => session.dirty("questions", value)}
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
    childTitle?: string;
    where?: string;
    onReply(id: string, answers?: string[][]): Promise<void>;
    onDirty(value: boolean): void;
  },
) {
  const form = createQuestionForm(props.request, solidState);
  const [collapsed, setCollapsed] = createSignal(false),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  let card!: HTMLElement, advance!: HTMLButtonElement, alive = true;
  const rowRefs: HTMLElement[][] = form.questions.map(() => []);
  const ownFields: HTMLTextAreaElement[] = [];
  const step = () => form.state.step;
  const onReview = () => step() === form.review;
  const reply = async (answers?: string[][]) => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      await props.onReply(props.request.id, answers);
      forgetQuestionForm(props.request.id);
      if (alive) props.onDirty(false);
    } catch (failure) {
      if (alive) setError((failure as Error).message);
    } finally {
      if (alive) setPending(false);
    }
  };
  const submit = () => reply(form.answers());
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
    hidden: true,
    run: () => {
      if (document.activeElement instanceof HTMLTextAreaElement) {
        focusCurrent(true);
      } else return reject();
    },
  });
  const answer = () => (onReview() ? submit() : form.next());
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
    const stopDirty = form.subscribe(() => props.onDirty(true));
    const release = ports.keyboard?.layer(
      "question.close",
      () => card.contains(document.activeElement),
      20,
    );
    return () => {
      stopDirty();
      release?.();
      alive = false;
      props.onDirty(false);
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
  const ownRow = (index: number) => (
    <div
      data-question-row
      ref={(element) => {
        rowRefs[index][form.questions[index].options.length] = element;
      }}
      data-otk-selection="vertical"
      {...selection({
        class: "otk-question-row",
        kind: "pressed",
        selected: form.isOwnChosen(index),
      })}
      role="button"
      tabindex="-1"
      onClick={(event) => {
        const field = ownFields[index];
        if (event.target !== field) {
          form.chooseOwn(index);
          field?.focus();
        }
      }}
    >
      <SelectionContent class="otk-question-content">
        <span>Type your own answer</span>
        <ContentTextarea
          ref={(element) => {
            ownFields[index] = element;
          }}
          class="otk-question-own"
          name="question-answer"
          rows={1}
          placeholder="Your answer…"
          value={form.state.drafts[index].own}
          onInput={(event) => {
            const field = event.currentTarget;
            form.typeOwn(index, field.value);
          }}
        />
      </SelectionContent>
    </div>
  );
  const questionPanel = (index: number) => {
    const q = form.questions[index];
    return (
      <>
        <p class="otk-question-text">
          {q.text}
          {q.multiple ? " (select all that apply)" : ""}
        </p>
        <div class="otk-question-options">
          <For each={q.options} keyed={false}>
            {(option, i) => (
              <button
                type="button"
                data-question-row
                ref={(element) => {
                  rowRefs[index][i] = element;
                }}
                data-otk-selection="vertical"
                {...selection({
                  class: "otk-question-row",
                  kind: "pressed",
                  selected: form.isPicked(index, i),
                })}
                onClick={() => form.pick(index, i)}
              >
                <SelectionContent class="otk-question-content">
                  <span>{option().label}</span>
                  <span class="otk-muted">{option().description}</span>
                </SelectionContent>
              </button>
            )}
          </For>
          <Show when={q.custom}>{ownRow(index)}</Show>
        </div>
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
        actions={
          <div class="otk-question-actions">
            <button
              type="button"
              class="otk-primary otk-pill"
              ref={(element) => {
                advance = element;
              }}
              disabled={pending()}
              onClick={() => void answer()}
              title={onReview() ? "Send the answers" : "Next step"}
            >
              Answer
            </button>
            <button
              type="button"
              class="otk-pill"
              disabled={pending()}
              onClick={() => void reject()}
              title="Skip question (Esc with question controls focused)"
            >
              Skip question
            </button>
            <button
              type="button"
              class="otk-pill otk-question-submit"
              disabled={pending()}
              onClick={() => void submit()}
              title="Send the answers given so far"
            >
              Submit
            </button>
          </div>
        }
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
                panel: () => (
                  <QuestionAnswers
                    items={form.questions.map((q, i) => ({
                      question: q.header || q.text,
                      answer: form.answers()[i].join(", ") || "(not answered)",
                    }))}
                  />
                ),
              },
            ]}
            selected={step()}
            onSelect={goTo}
          />
        </Show>
        <Show when={error()}>
          <p role="alert" class="otk-error">{error()}</p>
        </Show>
      </Takeover>
    </section>
  );
}
export default function QuestionDock(
  props: {
    request?: QuestionRequest;
    childTitle?: string;
    where?: string;
    onReply(id: string, answers?: string[][]): Promise<void>;
    onDirty(value: boolean): void;
  },
): import("solid-js").Element {
  return (
    <For each={props.request ? [props.request] : []} keyed={(q) => q.id}>
      {(q) => (
        <Request
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

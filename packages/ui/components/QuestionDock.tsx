// SPDX-License-Identifier: LGPL-3.0-only
import "./QuestionDock.css" with { type: "text" };
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
import { createSignal, For, onSettled, Show } from "solid-js";
import type { QuestionRequest } from "@otk/protocol";
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
import {
  ownedAction,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
function Request(
  props: {
    request: QuestionRequest;
    childTitle?: string;
    where?: string;
    onReply(id: string, answers?: string[][]): Promise<void>;
    onDirty(value: boolean): void;
  },
) {
  const [tab, setTab] = createSignal(0),
    [selected, setSelected] = createSignal(0),
    [answers, setAnswers] = createSignal<string[][]>([]),
    [custom, setCustom] = createSignal<string[]>([]),
    [editing, setEditing] = createSignal(false),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  let dock!: HTMLElement, input: HTMLTextAreaElement | undefined, active = true;
  const question = () => props.request.questions[tab()];
  const confirm = () => tab() === props.request.questions.length;
  const moveTab = (next: number) => {
    setTab(
      (next + props.request.questions.length + 1) %
        (props.request.questions.length + 1),
    );
    setSelected(0);
    setEditing(false);
  };
  const reply = async (reject = false) => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      await props.onReply(
        props.request.id,
        reject
          ? undefined
          : props.request.questions.map((_, i) => answers()[i] || []),
      );
      if (active) props.onDirty(false);
    } catch (error) {
      if (active) setError((error as Error).message);
    } finally {
      if (active) setPending(false);
    }
  };
  const pick = (label: string) => {
    const existing = answers()[tab()] || [],
      next = question().multiple
        ? existing.includes(label)
          ? existing.filter((value) => value !== label)
          : [...existing, label]
        : [label];
    setAnswers(
      answers().map((v, i) => i === tab() ? next : v).concat(
        Array.from(
          { length: Math.max(0, tab() + 1 - answers().length) },
          (_, i) => i + answers().length === tab() ? next : [],
        ),
      ),
    );
    props.onDirty(true);
    if (!question().multiple) moveTab(tab() + 1);
  };
  const choose = (index: number) => {
    setSelected(index);
    if (index < question().options.length) {
      pick(question().options[index].label);
    } else if (question().custom) {
      setEditing(true);
      requestAnimationFrame(() => input?.focus());
    }
  };
  const saveCustom = () => {
    const value = custom()[tab()]?.trim();
    if (!value) {
      setEditing(false);
      return;
    }
    pick(value);
    setEditing(false);
    dock.focus();
  };
  const ports = useCommandPorts();
  const reject = ownedCommand(ports, {
    id: "question.reject",
    title: "Reject question",
    category: "Attention",
    enabled: () => !pending(),
    run: () => reply(true),
  });
  const answerCommand = ownedAction(
    "question.answer",
    (reject: boolean = false) => reply(reject),
  );
  const tabCommand = ownedAction("question.tab", moveTab);
  const chooseCommand = ownedAction("question.choose", choose);
  const customCommand = ownedAction("question.custom", saveCustom);
  const moveChoice = ownedAction(
    "question.move",
    (input: { delta: number; total: number }) =>
      setSelected((selected() + input.delta + input.total) % input.total),
  );
  const close = ownedCommand(ports, {
    id: "question.close",
    title: "Close question layer",
    category: "Attention",
    hidden: true,
    run: () => {
      if (editing()) {
        setEditing(false);
        dock.focus();
      } else return reject();
    },
  });
  onSettled(() => {
    const release = ports.keyboard?.layer(
      "question.close",
      () => editing() || dock.contains(document.activeElement),
      20,
    );
    return () => {
      release?.();
      active = false;
      props.onDirty(false);
    };
  });
  return (
    <section
      class="otk-question-dock"
      tabindex="0"
      aria-label="Pending question"
      ref={(el) => {
        dock = el;
      }}
      onKeyDown={(event) => {
        if (pending() || !dock.contains(document.activeElement)) return;
        const typing = event.target instanceof HTMLTextAreaElement;
        if (typing) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            void close();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            void customCommand();
          }
          return;
        }
        const key = event.key,
          total = (question()?.options.length || 0) +
            (question()?.custom ? 1 : 0);
        if (
          ![
            "Escape",
            "Enter",
            "h",
            "l",
            "j",
            "k",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
          ].includes(key) && !/^\d$/.test(key)
        ) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === "Escape") void close();
        else if (["h", "ArrowLeft"].includes(key)) void tabCommand(tab() - 1);
        else if (["l", "ArrowRight"].includes(key)) {
          void tabCommand(tab() + 1);
        } else if (key === "Enter") {
          if (confirm()) void answerCommand(false);
          else void chooseCommand(selected());
        } else if (!confirm() && total) {
          if (["j", "ArrowDown", "k", "ArrowUp"].includes(key)) {
            void moveChoice({
              delta: ["k", "ArrowUp"].includes(key) ? -1 : 1,
              total,
            });
          } else if (Number(key) >= 1 && Number(key) <= total) {
            void chooseCommand(
              Number(key) - 1,
            );
          }
        }
      }}
    >
      <TakeoverHeader
        title="The agent asks"
        where={props.where}
        childTitle={props.childTitle}
      />
      <div class="otk-question-tabs" role="tablist">
        <For each={props.request.questions} keyed={false}>
          {(q, i) => (
            <button
              type="button"
              role="tab"
              data-otk-selection="horizontal"
              {...selection({ kind: "selected", selected: tab() === i })}
              onClick={() => void tabCommand(i)}
            >
              {q().header || `Question ${i + 1}`}
            </button>
          )}
        </For>
        <button
          type="button"
          role="tab"
          data-otk-selection="horizontal"
          {...selection({ kind: "selected", selected: confirm() })}
          onClick={() => void tabCommand(props.request.questions.length)}
        >
          Confirm
        </button>
      </div>
      <Show when={!confirm()}>
        <p>
          {question()?.text}
          {question()?.multiple ? " (select all that apply)" : ""}
        </p>
        <div class="otk-question-options">
          <For each={question()?.options || []} keyed={false}>
            {(option, i) => (
              <button
                type="button"
                {...selection({
                  kind: "pressed",
                  selected: answers()[tab()]?.includes(option().label) ?? false,
                  candidate: selected() === i,
                })}
                data-otk-selection="vertical"
                title={`Choose ${i + 1}`}
                onClick={() => void chooseCommand(i)}
              >
                <SelectionContent class="otk-question-content">
                  <span>{option().label}</span>
                  <span class="otk-muted">{option().description}</span>
                </SelectionContent>
              </button>
            )}
          </For>
          <Show when={question()?.custom}>
            <button
              type="button"
              onClick={() => void chooseCommand(question().options.length)}
              data-otk-selection="vertical"
              {...selection({
                class: "otk-question-own",
                kind: "candidate",
                selected: selected() === question().options.length,
              })}
            >
              <SelectionContent>Or type your own answer</SelectionContent>
            </button>
          </Show>
        </div>
        <Show when={editing()}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void customCommand();
            }}
          >
            <label>
              Custom answer<textarea
                name="question-answer"
                ref={(el) => {
                  input = el;
                }}
                value={custom()[tab()] || ""}
                onInput={(event) => {
                  const values = [...custom()];
                  values[tab()] = event.currentTarget.value;
                  setCustom(values);
                  props.onDirty(true);
                }}
              />
            </label>
            <button type="submit" class="otk-pill">Use answer</button>
          </form>
        </Show>
        <Show when={question()?.multiple}>
          <button type="button" onClick={() => void tabCommand(tab() + 1)}>
            Next question
          </button>
        </Show>
      </Show>
      <Show when={confirm()}>
        <dl>
          <For each={props.request.questions} keyed={false}>
            {(q, i) => (
              <div>
                <dt>{q().header || q().text}</dt>
                <dd>{answers()[i]?.join(", ") || "(not answered)"}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      <div class="otk-question-actions">
        <button
          type="button"
          disabled={pending()}
          onClick={() =>
            void (confirm()
              ? answerCommand(false)
              : tabCommand(props.request.questions.length))}
          class="otk-primary otk-pill"
          title="Answer (Enter on Confirm)"
        >
          Answer
        </button>
        <button
          type="button"
          disabled={pending()}
          onClick={() => void reject()}
          class="otk-pill"
          title="Skip question (Esc)"
        >
          Skip question
        </button>
      </div>
      <Show when={error()}>
        <p role="alert" class="otk-error">{error()}</p>
      </Show>
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

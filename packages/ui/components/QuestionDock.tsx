// SPDX-License-Identifier: LGPL-3.0-only
import "./QuestionDock.css" with { type: "text" };
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
function Request(
  props: {
    request: QuestionRequest;
    childTitle?: string;
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
  onSettled(() => {
    return () => {
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
            setEditing(false);
            dock.focus();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            saveCustom();
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
        if (key === "Escape") void reply(true);
        else if (["h", "ArrowLeft"].includes(key)) moveTab(tab() - 1);
        else if (["l", "ArrowRight"].includes(key)) {
          moveTab(tab() + 1);
        } else if (key === "Enter") {
          if (confirm()) void reply();
          else choose(selected());
        } else if (!confirm() && total) {
          if (["j", "ArrowDown", "k", "ArrowUp"].includes(key)) {
            setSelected(
              (selected() + (["k", "ArrowUp"].includes(key) ? -1 : 1) + total) %
                total,
            );
          } else if (Number(key) >= 1 && Number(key) <= total) {
            choose(
              Number(key) - 1,
            );
          }
        }
      }}
    >
      <header>
        <h2>Question</h2>
        <Show when={props.childTitle}>
          <span>From {props.childTitle}</span>
        </Show>
      </header>
      <div class="otk-question-tabs" role="tablist">
        <For each={props.request.questions} keyed={false}>
          {(q, i) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === i ? "true" : "false"}
              onClick={() => moveTab(i)}
            >
              {q().header || `Question ${i + 1}`}
            </button>
          )}
        </For>
        <button
          type="button"
          role="tab"
          aria-selected={confirm() ? "true" : "false"}
          onClick={() => moveTab(props.request.questions.length)}
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
                aria-pressed={answers()[tab()]?.includes(option().label)
                  ? "true"
                  : "false"}
                data-active={selected() === i}
                onClick={() => choose(i)}
              >
                <span>{i + 1}. {option().label}</span>
                <span class="otk-muted">{option().description}</span>
              </button>
            )}
          </For>
          <Show when={question()?.custom}>
            <button
              type="button"
              onClick={() => choose(question().options.length)}
            >
              Type your own answer
            </button>
          </Show>
        </div>
        <Show when={editing()}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveCustom();
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
            <button type="submit">Use answer</button>
          </form>
        </Show>
        <Show when={question()?.multiple}>
          <button type="button" onClick={() => moveTab(tab() + 1)}>
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
        <Show when={confirm()}>
          <button
            type="button"
            disabled={pending()}
            onClick={() => void reply()}
          >
            Confirm answers
          </button>
        </Show>
        <button
          type="button"
          disabled={pending()}
          onClick={() => void reply(true)}
        >
          Reject question
        </button>
        <span class="otk-muted">
          j/k select · h/l switch · numbers choose · Esc reject
        </span>
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
          onReply={props.onReply}
          onDirty={props.onDirty}
        />
      )}
    </For>
  );
}

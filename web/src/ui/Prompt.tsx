// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled, Show } from "solid-js";
export default function Prompt(
  props: {
    value: string;
    connected: boolean;
    onChange(value: string): void;
    onSubmit(text: string): Promise<void>;
    onAbort(): Promise<void>;
  },
) {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(""),
    [armed, setArmed] = createSignal(false);
  let deadline = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const submit = async () => {
    if (!props.value.trim() || !props.connected || pending()) return;
    const text = props.value;
    setPending(true);
    setError("");
    try {
      await props.onSubmit(text);
      if (active && props.value === text) props.onChange("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  const escape = async (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !props.connected) {
      return;
    }
    event.preventDefault();
    if (Date.now() < deadline) {
      deadline = 0;
      clearTimeout(timer);
      setArmed(false);
      try {
        await props.onAbort();
      } catch (error) {
        setError((error as Error).message);
      }
    } else {
      deadline = Date.now() + 5000;
      setArmed(true);
      timer = setTimeout(() => {
        deadline = 0;
        setArmed(false);
      }, 5000);
    }
  };
  onSettled(() => {
    document.addEventListener("keydown", escape);
    return () => {
      active = false;
      document.removeEventListener("keydown", escape);
      clearTimeout(timer);
    };
  });
  return (
    <form
      class="otk-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label for="otk-prompt-input">Prompt</label>
      <textarea
        id="otk-prompt-input"
        name="prompt"
        placeholder="Message the agent…"
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div class="otk-prompt-actions">
        <span class="otk-muted">
          {armed()
            ? "esc again to interrupt"
            : "Enter to send · Shift+Enter for newline · Esc twice to interrupt"}
        </span>
        <button
          type="submit"
          disabled={pending() || !props.connected || !props.value.trim()}
        >
          Send
        </button>
      </div>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
    </form>
  );
}

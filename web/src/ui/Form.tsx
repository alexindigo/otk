// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, type Element, Show } from "solid-js";
export default function Form(
  props: {
    title: string;
    submitLabel: string;
    children: Element;
    onSubmit(form: FormData): Promise<void>;
  },
) {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    setPending(true);
    setError("");
    try {
      await props.onSubmit(data);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <form class="otk-form" onSubmit={submit}>
      <h2>{props.title}</h2>
      <fieldset disabled={pending()}>{props.children}</fieldset>
      <Show when={error()}>
        <p role="alert" class="otk-error">{error()}</p>
      </Show>
      <button type="submit" disabled={pending()}>
        {pending() ? "Please wait…" : props.submitLabel}
      </button>
    </form>
  );
}
export function Credentials(
  props: { required: boolean; newPassword?: boolean },
) {
  return (
    <>
      <label>
        Username<input
          name="username"
          autocomplete="username"
          required={props.required}
        />
      </label>
      <label>
        Password<input
          name="password"
          type="password"
          autocomplete={props.newPassword ? "new-password" : "current-password"}
          required={props.required}
        />
      </label>
    </>
  );
}

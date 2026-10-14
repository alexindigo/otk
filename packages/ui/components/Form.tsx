// SPDX-License-Identifier: LGPL-3.0-only
import "./Form.css" with { type: "text" };
import { createSignal, type Element, Show } from "solid-js";
import { ownedAction } from "../keyboard/context.tsx";
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
  const send = ownedAction(
    "form.submit",
    (data: FormData) => props.onSubmit(data),
  );
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    setPending(true);
    setError("");
    try {
      await send(data);
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

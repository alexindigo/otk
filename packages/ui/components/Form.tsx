// SPDX-License-Identifier: LGPL-3.0-only
import {
  createFailurePresenter,
  createFormIntent,
  type Feedback,
} from "@otk/client";
import "./Form.css" with { type: "text" };
import {
  createContext,
  createSignal,
  createUniqueId,
  type Element,
  onCleanup,
  useContext,
} from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
import { ownedAction } from "../keyboard/context.tsx";
import FieldFeedback from "./FieldFeedback.tsx";
const FormContext = createContext<
  { pending(): boolean; feedback(): Feedback | undefined }
>();
export default function Form(
  props: {
    title: string;
    submitLabel: string;
    pendingLabel?: string;
    children: Element;
    onSubmit(form: FormData): Promise<void>;
  },
): Element {
  const intent = createFormIntent<FormData, void>({
    capture(value) {
      const captured = new FormData();
      for (const [name, item] of value) captured.append(name, item);
      return captured;
    },
    presenter: createFailurePresenter(),
    diagnostic: (id, cause) => console.error("Form diagnostic", id, cause),
  });
  const [revision, setRevision] = createSignal(0);
  onCleanup(intent.subscribe(() => setRevision(revision() + 1)));
  const state = () => {
    revision();
    return intent.state;
  };
  const pending = () => state().pending;
  const context = { pending, feedback: () => state().feedback };
  let status!: HTMLSpanElement;
  const send = ownedAction(
    "form.submit",
    (data: FormData) => props.onSubmit(data),
  );
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const focus = event.submitter === document.activeElement;
    try {
      const work = intent.submit(data, send);
      if (focus) queueMicrotask(() => status?.focus());
      await work;
    } catch { /* The client intent owns classified feedback. */ }
  };
  return (
    <FormContext value={context}>
      <form
        class={["otk-form", { "is-pending": pending() }]}
        onSubmit={submit}
        aria-busy={pending() ? "true" : undefined}
      >
        <fieldset aria-label={props.title}>
          {props.children}
        </fieldset>
        <FieldFeedback
          action
          feedback={state().feedback?.field ? undefined : state().feedback}
        />
        <div class="otk-form-action">
          <button type="submit">{props.submitLabel}</button>
          <span ref={status} role="status" tabindex={-1}>
            {pending() ? props.pendingLabel ?? "Working…" : ""}
          </span>
        </div>
      </form>
    </FormContext>
  );
}
/** Native fields borrow the form's captured lifetime without parent DOM mutation. */
export function FormInput(props: ComponentProps<"input">): Element {
  const form = useContext(FormContext), id = createUniqueId();
  const native = nativeAttributes(() => props);
  const feedback = () =>
    form?.feedback()?.field === props.name ? form.feedback() : undefined;
  return (
    <>
      <input
        {...native.attributes}
        ref={[props.ref, native.ref]}
        readonly={form?.pending() || props.readonly}
        aria-describedby={id}
        aria-invalid={feedback()?.kind === "error" ? "true" : undefined}
      />
      <FieldFeedback id={id} feedback={feedback()} />
    </>
  );
}
export function FormTextarea(props: ComponentProps<"textarea">): Element {
  const form = useContext(FormContext), native = nativeAttributes(() => props);
  return (
    <textarea
      {...native.attributes}
      ref={[props.ref, native.ref]}
      readonly={form?.pending() || props.readonly}
    />
  );
}
export function FormSelect(props: ComponentProps<"select">): Element {
  const form = useContext(FormContext), native = nativeAttributes(() => props);
  let select!: HTMLSelectElement;
  const label = () => {
    form?.pending();
    return select?.selectedOptions[0]?.textContent ?? String(props.value ?? "");
  };
  return (
    <span class={["otk-form-choice", { "is-pending": form?.pending() }]}>
      <select
        {...native.attributes}
        ref={[props.ref, native.ref, (element) => select = element]}
      >
        {props.children}
      </select>
      <input
        class="otk-form-choice-value"
        value={label()}
        readonly
        aria-label={props.name}
      />
    </span>
  );
}
export function Credentials(
  props: { required: boolean; newPassword?: boolean },
): Element {
  return (
    <>
      <label>
        Username<FormInput
          name="username"
          autocomplete="username"
          required={props.required}
        />
      </label>
      <label>
        Password<FormInput
          name="password"
          type="password"
          autocomplete={props.newPassword ? "new-password" : "current-password"}
          required={props.required}
        />
      </label>
    </>
  );
}

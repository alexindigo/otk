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
  Show,
  useContext,
} from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { nativeAttributes } from "./native-attributes.ts";
import { ownedAction } from "../keyboard/context.tsx";
import FieldFeedback from "./FieldFeedback.tsx";
import ActionSlot from "./ActionSlot.tsx";
import Select from "./Select.tsx";
import { scrollRegion } from "./ScrollRegion.tsx";
const FormContext = createContext<
  | { pending(): boolean; feedback(): Feedback | undefined; feedbackID: string }
  | null
>(null);
export default function Form(
  props: {
    title: string;
    submitLabel: string;
    pendingLabel?: string;
    /** Read-only probes capture a value but do not lock the user's next edit. */
    editableWhilePending?: boolean;
    feedback?: Feedback | null;
    onCancel?(): Promise<void>;
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
  const feedback = () =>
    props.feedback === undefined
      ? state().feedback
      : props.feedback ?? undefined;
  const context = {
    pending: () => pending() && !props.editableWhilePending,
    feedback,
    feedbackID: createUniqueId(),
  };
  let status: { focus(): void } | undefined, button!: HTMLButtonElement;
  const send = ownedAction(
    "form.submit",
    (data: FormData) => props.onSubmit(data),
    { arguments: { type: "local" } },
  );
  const cancel = ownedAction("form.cancel", () => props.onCancel?.(), {
    enabled: () => pending() && !!props.onCancel,
  });
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
        <ActionSlot
          class="otk-form-action"
          align="end"
          pending={pending()}
          control={(control) => status = control}
          focusAction={() => {
            if (button.isConnected) button.focus();
          }}
          feedback={pending()
            ? { kind: "pending", text: props.pendingLabel ?? "Working…" }
            : undefined}
        >
          <button
            class="otk-primary"
            ref={(element) => button = element}
            type="submit"
          >
            {props.submitLabel}
          </button>
        </ActionSlot>
        <Show when={pending() && props.onCancel}>
          <button type="button" onClick={() => void cancel()}>
            Cancel
          </button>
        </Show>
        <FieldFeedback id={context.feedbackID} action feedback={feedback()} />
      </form>
    </FormContext>
  );
}
/** Native fields borrow the form's captured lifetime without parent DOM mutation. */
function formField(
  name: () => unknown,
  described: () => unknown,
) {
  const form = useContext(FormContext),
    id = form?.feedbackID ?? createUniqueId();
  const feedback = () =>
    typeof name() === "string" && form?.feedback()?.field === name()
      ? form?.feedback()
      : undefined;
  return {
    form,
    id,
    feedback,
    get description() {
      const description = described();
      return [typeof description === "string" ? description : undefined, id]
        .filter(Boolean).join(" ");
    },
    get invalid(): "true" | undefined {
      return feedback()?.kind === "error" ? "true" : undefined;
    },
  };
}
export function FormInput(props: ComponentProps<"input">): Element {
  const field = formField(() => props.name, () => props["aria-describedby"]);
  const native = nativeAttributes(() => props);
  return (
    <>
      <input
        {...native.attributes}
        ref={[props.ref, native.ref]}
        readonly={field.form?.pending() || props.readonly}
        aria-describedby={field.description}
        aria-invalid={field.invalid}
      />
      <Show when={!field.form}>
        <FieldFeedback id={field.id} feedback={field.feedback()} />
      </Show>
    </>
  );
}
export function FormTextarea(props: ComponentProps<"textarea">): Element {
  const field = formField(() => props.name, () => props["aria-describedby"]),
    native = nativeAttributes(() => props);
  return (
    <>
      <textarea
        {...native.attributes}
        ref={[props.ref, native.ref]}
        class={[scrollRegion(), props.class]}
        readonly={field.form?.pending() || props.readonly}
        aria-describedby={field.description}
        aria-invalid={field.invalid}
      />
      <Show when={!field.form}>
        <FieldFeedback id={field.id} feedback={field.feedback()} />
      </Show>
    </>
  );
}
export function FormSelect(
  props: ComponentProps<"select"> & { pending?: boolean },
): Element {
  const field = formField(() => props.name, () => props["aria-describedby"]),
    form = field.form,
    native = nativeAttributes(() => ({ ...props, pending: undefined }));
  let select!: HTMLSelectElement;
  const label = () => {
    pending();
    return select?.selectedOptions[0]?.textContent ?? String(props.value ?? "");
  };
  const pending = () => form?.pending() || props.pending;
  return (
    <>
      <span class={["otk-form-choice", { "is-pending": pending() }]}>
        <Select
          {...native.attributes}
          containerClass="otk-form-choice-input"
          ref={[props.ref, native.ref, (element) => select = element]}
          aria-describedby={field.description}
          aria-invalid={field.invalid}
        >
          {props.children}
        </Select>
        <input
          class="otk-form-choice-value"
          value={label()}
          readonly
          aria-label={props.name}
          aria-describedby={field.description}
        />
      </span>
      <Show when={!field.form}>
        <FieldFeedback id={field.id} feedback={field.feedback()} />
      </Show>
    </>
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

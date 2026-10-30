// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import Form, {
  FormInput,
  FormSelect,
  FormTextarea,
} from "../../components/Form.tsx";
import { RequestFailure } from "@otk/client";

export default function Forms() {
  let settle: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const [calls, setCalls] = createSignal(0);
  styleTest.fieldFailure = (name) =>
    settle?.reject(
      new RequestFailure({
        code: "request.params",
        field: name,
        retry: "new-intent",
        diagnosticID: "field-proof",
      }),
    );
  styleTest.feedback = (state) => {
    if (state === "error") {
      settle?.reject(new Error("private SQL /secret/path native exception"));
    } else if (state === "clear") settle?.resolve();
  };
  return (
    <section data-form-calls={calls()}>
      <Form
        title="New task"
        submitLabel="Save task"
        onSubmit={async () => {
          setCalls(calls() + 1);
          settle = Promise.withResolvers<void>();
          await settle.promise;
        }}
      >
        <label>
          Name<FormInput name="taskName" required value="perf" />
        </label>
        <label>
          Notes<FormTextarea
            name="notes"
            value="Keep this text"
            aria-describedby="notes-help"
          />
        </label>
        <span id="notes-help">Notes stay with this action</span>
        <label>
          Kind<FormSelect name="kind" value="alpha">
            <option value="alpha">Alpha</option>
            <option value="beta">Beta</option>
          </FormSelect>
        </label>
      </Form>
    </section>
  );
}

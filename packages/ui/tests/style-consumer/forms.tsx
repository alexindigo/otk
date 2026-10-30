// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import Form, { FormInput } from "../../components/Form.tsx";

export default function Forms() {
  let settle: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const [calls, setCalls] = createSignal(0);
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
      </Form>
    </section>
  );
}

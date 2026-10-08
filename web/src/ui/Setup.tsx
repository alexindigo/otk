// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import Form, { Credentials } from "./Form.tsx";
export default function Setup(
  props: {
    onSetup(
      input: { type: string; username: string; password: string },
    ): Promise<void>;
  },
) {
  const [type, setType] = createSignal("password");
  return (
    <Form
      title="Configure this sidecar"
      submitLabel="Configure sidecar"
      onSubmit={(data) =>
        props.onSetup({
          type: String(data.get("type")),
          username: String(data.get("username") ?? ""),
          password: String(data.get("password") ?? ""),
        })}
    >
      <label>
        Authentication<select
          name="type"
          value={type()}
          onChange={(event) => setType(event.currentTarget.value)}
        >
          <option value="password">Password</option>
          <option value="none">None</option>
        </select>
      </label>
      <Credentials required={type() === "password"} newPassword />
    </Form>
  );
}

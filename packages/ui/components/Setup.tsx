// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Show } from "solid-js";
import Form, { FormInput, FormSelect } from "./Form.tsx";
import AuthColumn from "./AuthColumn.tsx";
export default function Setup(
  props: {
    onSetup(
      input: { type: string; username: string; password: string },
    ): Promise<void>;
  },
): import("solid-js").Element {
  const [type, setType] = createSignal("password");
  const [username, setUsername] = createSignal(""),
    [password, setPassword] = createSignal("");
  return (
    <AuthColumn
      title="Set up OTK"
      description="Choose how to sign in to this OTK server."
    >
      <Form
        title="Set up OTK"
        submitLabel="Set up OTK"
        pendingLabel="Configuring server…"
        onSubmit={(data) =>
          props.onSetup({
            type: String(data.get("type")),
            username: String(data.get("username") ?? ""),
            password: String(data.get("password") ?? ""),
          })}
      >
        <label>
          Sign-in method<FormSelect
            name="type"
            value={type()}
            onChange={(event) => setType(event.currentTarget.value)}
          >
            <option value="password">Password</option>
            <option value="none">None</option>
          </FormSelect>
        </label>
        <Show when={type() === "password"}>
          <label>
            Username<FormInput
              name="username"
              autocomplete="username"
              required
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
          </label>
          <label>
            Password<FormInput
              name="password"
              type="password"
              autocomplete="new-password"
              required
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </label>
        </Show>
      </Form>
    </AuthColumn>
  );
}

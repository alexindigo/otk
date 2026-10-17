// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import Form, { Credentials } from "./Form.tsx";
export default function Login(
  props: {
    label: string;
    authType?: string;
    onLogin(input: { username: string; password: string }): Promise<void>;
  },
): import("solid-js").Element {
  return (
    <>
      <h2>Log in · {props.label}</h2>
      <Form
        title={`Log in · ${props.label}`}
        submitLabel="Log in"
        onSubmit={(data) =>
          props.onLogin({
            username: String(data.get("username")),
            password: String(data.get("password")),
          })}
      >
        <Credentials required />
        <Show when={props.authType === "totp"}>
          <p class="otk-muted">
            Append your six-digit TOTP code to your password.
          </p>
        </Show>
      </Form>
    </>
  );
}

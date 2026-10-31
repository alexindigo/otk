// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import Form, { Credentials } from "./Form.tsx";
import AuthColumn from "./AuthColumn.tsx";
export default function Login(
  props: {
    label: string;
    authType?: string;
    onLogin(input: { username: string; password: string }): Promise<void>;
  },
): import("solid-js").Element {
  return (
    <AuthColumn title={`Log in · ${props.label}`}>
      <Form
        title={`Log in · ${props.label}`}
        submitLabel="Log in"
        pendingLabel="Signing in…"
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
    </AuthColumn>
  );
}

// SPDX-License-Identifier: LGPL-3.0-only
import "./Settings.css" with { type: "text" };
import { For, Show } from "solid-js";
import { LOCAL_SIDECAR, type SidecarState } from "@otk/client";
import Form from "./Form.tsx";
import Login from "./Login.tsx";
import Setup from "./Setup.tsx";
import ConnectionBadge from "./ConnectionBadge.tsx";
import { ownedAction } from "../keyboard/context.tsx";
export default function Settings(props: {
  sidecars: SidecarState[];
  onAdd(url: string, label: string): Promise<void>;
  onRemove(id: string): void;
  onLogin(
    id: string,
    input: { username: string; password: string },
  ): Promise<void>;
  onSetup(
    input: { type: string; username: string; password: string },
  ): Promise<void>;
  onClose(): void;
  notifications?: import("solid-js").Element;
}): import("solid-js").Element {
  const close = ownedAction("settings.close", () => props.onClose());
  const remove = ownedAction(
    "sidecar.remove",
    (id: string) => props.onRemove(id),
  );
  return (
    <section class="otk-settings" aria-label="Settings">
      <header class="otk-view-header">
        <h1>Settings / sidecars</h1>
        <button type="button" onClick={() => void close()}>
          Close settings
        </button>
      </header>
      <div class="otk-settings-content">
        {props.notifications}
        <p class="otk-muted">
          A remote sidecar must list this page’s origin,{" "}
          <code>{location.origin}</code>, in <code>server.origins</code>.
        </p>
        <For each={props.sidecars} keyed={(item) => item.id}>
          {(sidecar) => (
            <section
              class="otk-sidecar-card"
              data-settings-sidecar={sidecar().id}
            >
              <header>
                <h2>{sidecar().label}</h2>
                <Show when={sidecar().id !== LOCAL_SIDECAR}>
                  <button
                    type="button"
                    onClick={() => void remove(sidecar().id)}
                  >
                    Remove sidecar
                  </button>
                </Show>
              </header>
              <p>{sidecar().baseUrl || "Serving sidecar · relative /api/"}</p>
              <ConnectionBadge sidecar={sidecar()} />
              <Show when={sidecar().error}>
                <p class="otk-error" role="alert">{sidecar().error}</p>
              </Show>
              <Show when={sidecar().status === "login required"}>
                <Login
                  label={sidecar().label}
                  authType={sidecar().authType}
                  onLogin={(input) => props.onLogin(sidecar().id, input)}
                />
              </Show>
              <Show when={sidecar().status === "setup required"}>
                <Show
                  when={sidecar().id === LOCAL_SIDECAR}
                  fallback={<p>Needs setup on that host.</p>}
                >
                  <Setup onSetup={(input) => props.onSetup(input)} />
                </Show>
              </Show>
            </section>
          )}
        </For>
        <Form
          title="Add sidecar"
          submitLabel="Add sidecar"
          onSubmit={async (data) => {
            await props.onAdd(
              String(data.get("url")),
              String(data.get("label") ?? ""),
            );
          }}
        >
          <label>
            Base URL<input
              name="url"
              type="url"
              placeholder="http://127.0.0.1:31502"
              required
            />
          </label>
          <label>
            Label<input name="label" placeholder="Optional name" />
          </label>
        </Form>
      </div>
    </section>
  );
}

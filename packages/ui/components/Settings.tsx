// SPDX-License-Identifier: LGPL-3.0-only
import { ViewHeader } from "./View.tsx";
import "./Settings.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import { For, Show } from "solid-js";
import { LOCAL_SIDECAR, type SidecarState } from "@otk/client";
import Form, { FormInput } from "./Form.tsx";
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
  appearance?: import("solid-js").Element;
  transcript?: import("solid-js").Element;
}): import("solid-js").Element {
  const defaults = () =>
    props.sidecars.find((item) => item.id === LOCAL_SIDECAR)?.defaults;
  const close = ownedAction("settings.close", () => props.onClose());
  const remove = ownedAction(
    "sidecar.remove",
    (id: string) => props.onRemove(id),
    { arguments: { type: "string" } },
  );
  return (
    <section class="otk-settings" aria-label="Settings">
      <ViewHeader
        title="Settings / servers"
        actions={
          <button
            type="button"
            onClick={() => void close()}
          >
            Close settings
          </button>
        }
      />
      <ScrollRegion class="otk-settings-body">
        <div class="otk-settings-content">
          {props.appearance}
          {props.transcript}
          {props.notifications}
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
                      Remove server
                    </button>
                  </Show>
                </header>
                <p>{sidecar().baseUrl || "Serving server · relative /api/"}</p>
                <ConnectionBadge sidecar={sidecar()} />
                <Show when={sidecar().error}>
                  <p class="otk-error" role="alert">{sidecar().error}</p>
                </Show>
                <Show when={sidecar().status === "login required"}>
                  <div class="otk-sidecar-auth">
                    <Login
                      label={sidecar().label}
                      authType={sidecar().authType}
                      onLogin={(input) => props.onLogin(sidecar().id, input)}
                    />
                  </div>
                </Show>
                <Show when={sidecar().status === "setup required"}>
                  <Show
                    when={sidecar().id === LOCAL_SIDECAR}
                    fallback={<p>Needs setup on that host.</p>}
                  >
                    <div class="otk-sidecar-auth">
                      <Setup onSetup={(input) => props.onSetup(input)} />
                    </div>
                  </Show>
                </Show>
              </section>
            )}
          </For>
          <h2>Add server</h2>
          <div class="otk-settings-server-help">
            <p>
              Enter the other computer's OTK address, not its opencode address.
            </p>
            <p>
              On that computer, edit{" "}
              <code>~/.config/otk/otk.toml</code>. If you set{" "}
              <code>XDG_CONFIG_HOME</code>, edit{" "}
              <code>$XDG_CONFIG_HOME/otk/otk.toml</code> instead. If you set
              {" "}
              <code>OTK_CONFIG</code>, edit the file it names.
            </p>
            <p>
              Under <code>[server]</code>, add <code>{location.origin}</code>
              {" "}
              to the <code>origins</code>{" "}
              list in quotes, keeping any addresses already there. A new list
              looks like <code>{`origins = ["${location.origin}"]`}</code>. Set
              {" "}
              <code>host</code>{" "}
              to that computer's network address so this page can reach OTK,
              then restart OTK.
            </p>
            <p>
              Environment variables override the file:{" "}
              <code>OTK_SERVER_HOST</code> sets the listening address;{" "}
              <code>OTK_SERVER_ORIGINS</code>{" "}
              sets the allowed page addresses, separated by commas.
            </p>
          </div>
          <Form
            title="Add server"
            submitLabel="Add server"
            pendingLabel="Checking server…"
            onSubmit={async (data) => {
              await props.onAdd(
                String(data.get("url")),
                String(data.get("label") ?? ""),
              );
            }}
          >
            <label>
              Base URL<FormInput
                name="url"
                type="url"
                placeholder={defaults()
                  ? `http://computer:${defaults()!.defaultPort}`
                  : undefined}
                required
              />
            </label>
            <label>
              Label<FormInput name="label" placeholder="Optional name" />
            </label>
          </Form>
        </div>
      </ScrollRegion>
    </section>
  );
}

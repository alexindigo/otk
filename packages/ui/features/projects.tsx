// SPDX-License-Identifier: LGPL-3.0-only
import "./projects.css" with { type: "text" };
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { DialogProps, DialogRegistry } from "../registries/shell.ts";
import { useShellPorts } from "../shell/context.tsx";
import CommandDialog from "../components/CommandDialog.tsx";
import Form from "../components/Form.tsx";

export function registerProjectDialogs(dialogs: DialogRegistry): void {
  dialogs.register({ id: "add-project", component: AddProject });
}
function AddProject(props: DialogProps) {
  const shell = useShellPorts();
  const [server, setServer] = createSignal(
    shell.servers().find((s) => s.status === "connected")?.id ?? "local",
  );
  const [paths, setPaths] = createSignal<string[]>([]),
    [loading, setLoading] = createSignal(false),
    [error, setError] = createSignal("");
  const [path, setPath] = createSignal("");
  let generation = 0;
  onCleanup(() => generation++);
  createEffect(
    () =>
      [
        server(),
        shell.servers().find((s) => s.id === server())?.status,
      ] as const,
    ([id, status]) => {
      const revision = ++generation;
      setPaths([]);
      setError("");
      if (status !== "connected") return;
      setLoading(true);
      void shell.connection(id).rpc.call("projects.scan", {}).then((paths) => {
        if (revision === generation) setPaths(paths);
      }, (error) => {
        if (revision === generation) setError((error as Error).message);
      }).finally(() => {
        if (revision === generation) setLoading(false);
      });
    },
  );
  return (
    <CommandDialog id="project.add" title="Add project" onClose={props.close}>
      <Form
        title="Project directory"
        submitLabel="Add project"
        onSubmit={async () => {
          const sidecarId = server(), directory = path().trim();
          const project = await shell.connection(sidecarId).rpc.call(
            "projects.add",
            { directory },
          );
          shell.openProject({ sidecarId, directory: project.directory });
          props.close();
        }}
      >
        <label>
          Server<select
            name="server"
            value={server()}
            onChange={(e) =>
              setServer(e.currentTarget.value)}
          >
            <For
              each={shell.servers()}
              keyed={(s) =>
                s.id}
            >
              {(s) => (
                <option value={s().id} disabled={s().status !== "connected"}>
                  {s().label}
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          Path<input
            name="directory"
            class="otk-path"
            required
            value={path()}
            placeholder="/home/me/Projects/my-project"
            onInput={(e) =>
              setPath(e.currentTarget.value)}
          />
        </label>
      </Form>
      <section class="otk-template-paths" aria-label="Scanned projects">
        <h3>From path templates</h3>
        <Show when={loading()}>
          <p class="otk-muted">Scanning directories…</p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="otk-error">{error()}</p>
        </Show>
        <For each={paths()} keyed={false}>
          {(directory) => (
            <button
              type="button"
              class="otk-path"
              onClick={() => setPath(directory())}
            >
              {directory()}
            </button>
          )}
        </For>
        <Show when={!loading() && !error() && !paths().length}>
          <p class="otk-muted">
            No matching directories. Set path templates in Settings, or type a
            path above.
          </p>
        </Show>
      </section>
    </CommandDialog>
  );
}

/** Server-scoped templates and host-owned ageing controls live with inbox UI. */
export function ProjectSettings(): import("solid-js").Element {
  const shell = useShellPorts();
  return (
    <section class="otk-project-settings" aria-label="Project settings">
      <h2>Projects</h2>
      <Form
        title="Ageing thresholds (hours)"
        submitLabel="Save ageing"
        onSubmit={async (data) => {
          const value = [1, 2, 3].map((n) =>
            Number(data.get(`age${n}`)) * 3_600_000
          );
          await shell.connection("local").rpc.call("prefs.set", {
            key: "projectAgeing",
            value,
          });
        }}
      >
        <div class="otk-ageing-fields">
          <For each={[0, 1, 2]}>
            {(n) => (
              <label>
                Level {n + 1}
                <input
                  name={`age${n + 1}`}
                  type="number"
                  min="0.01"
                  step="any"
                  required
                  value={shell.toggles.state.prefs.projectAgeing[n] / 3_600_000}
                />
              </label>
            )}
          </For>
        </div>
      </Form>
      <For each={shell.servers()} keyed={(s) => s.id}>
        {(s) => (
          <Form
            title={`${s().label} path templates`}
            submitLabel="Save templates"
            onSubmit={async (data) => {
              await shell.connection(s().id).rpc.call("projects.templates", {
                templates: String(data.get("templates") ?? "").split("\n").map((
                  s,
                ) => s.trim()).filter(Boolean),
              });
            }}
          >
            <label>
              One path per line; use {"{project}"} for a directory name<textarea
                name="templates"
                class="otk-path"
                disabled={s().status !== "connected"}
                value={shell.inbox(s().id).state.inbox.pathTemplates.join("\n")}
                placeholder="~/Projects/{project}/"
              />
            </label>
          </Form>
        )}
      </For>
    </section>
  );
}

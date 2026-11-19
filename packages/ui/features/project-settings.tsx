// SPDX-License-Identifier: LGPL-3.0-only
import { For, onCleanup, Show } from "solid-js";
import type { ProjectEditor } from "@otk/client";
import type { DialogProps, DialogRegistry } from "../registries/shell.ts";
import Form, { FormInput, FormTextarea } from "../components/Form.tsx";
import { ProjectAvatar } from "../components/ProjectChip.tsx";
import { toggle } from "../components/selection.ts";
import FeedbackStatus from "../components/FeedbackStatus.tsx";
import "./project-settings.css" with { type: "text" };

export interface ProjectSettingsInput {
  name: string;
  editor: ProjectEditor;
}
export function registerProjectSettings(dialogs: DialogRegistry): void {
  dialogs.register<ProjectSettingsInput>({
    id: "project-settings",
    size: "editor",
    title: (input) =>
      `${input.editor.state.values.name || input.name} / Project settings`,
    dismiss: (input, close) => {
      if (input.editor.dismiss()) close();
    },
    component: ProjectSettingsPage,
  });
}
function ProjectSettingsPage(props: DialogProps<ProjectSettingsInput>) {
  const editor = props.input.editor;
  let iconInput!: HTMLInputElement;
  onCleanup(() => editor.dispose());
  const has = (field: import("@otk/protocol").ProjectEditField) =>
    editor.state.fields.includes(field);
  const upload = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    await editor.image(() =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })
    );
  };
  return (
    <section class="otk-native-project-settings" aria-label="Project settings">
      <Show when={editor.state.confirming}>
        <section
          class="otk-project-dismiss"
          aria-label="Unsaved project settings"
        >
          <p>Discard unsaved changes? Any save already sent will finish.</p>
          <div class="otk-control-row">
            <button
              type="button"
              onClick={() =>
                editor.keepEditing()}
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={() =>
                props.close()}
            >
              Discard changes
            </button>
          </div>
        </section>
      </Show>
      <Show when={editor.state.fields.length}>
        <Form
          title="Project settings"
          submitLabel="Save changes"
          pendingLabel={editor.state.reading
            ? "Reading image..."
            : "Saving project settings..."}
          pending={editor.state.pending || editor.state.reading}
          feedback={editor.state.error || null}
          onSubmit={async () => {
            await editor.save();
          }}
        >
          <Show when={has("name")}>
            <label>
              Project name<FormInput
                name="projectName"
                value={editor.state.values.name}
                onInput={(e) => editor.edit("name", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={has("icon")}>
            <div class="otk-project-icon-field">
              <span class="otk-control-label">Icon</span>
              <div class="otk-control-row">
                <ProjectAvatar
                  name={editor.state.values.name || props.input.name}
                  icon={editor.state.values.icon || (!editor.state.values.color
                    ? editor.state.iconSource
                    : undefined)}
                  color={editor.state.colors.find((item) =>
                    item.value === editor.state.values.color
                  )?.color}
                />
                <button
                  type="button"
                  onClick={() =>
                    iconInput.click()}
                >
                  Upload image
                </button>
                <input
                  ref={(element) => iconInput = element}
                  name="projectIcon"
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    void upload(e.currentTarget.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
                <Show when={editor.state.values.icon}>
                  <button type="button" onClick={() => editor.edit("icon", "")}>
                    Remove icon
                  </button>
                </Show>
              </div>
            </div>
          </Show>
          <Show when={has("color")}>
            <fieldset class="otk-project-colors" aria-label="Color">
              <legend>Color</legend>
              <div class="otk-control-row">
                <button
                  type="button"
                  {...toggle({ on: !editor.state.values.color })}
                  onClick={() => editor.edit("color", "")}
                >
                  Default
                </button>
                <For each={editor.state.colors} keyed={(color) => color.value}>
                  {(color) => (
                    <button
                      type="button"
                      {...toggle({
                        on: editor.state.values.color === color().value,
                        class: "otk-project-color",
                      })}
                      aria-label={`${color().label} color`}
                      title={color().label}
                      onClick={() => editor.edit("color", color().value)}
                    >
                      <span
                        class="otk-project-color-swatch"
                        style={{ "--project-swatch": color().color }}
                      />
                    </button>
                  )}
                </For>
              </div>
            </fieldset>
          </Show>
          <Show when={has("startScript")}>
            <label>
              Worktree startup script<FormTextarea
                name="startScript"
                class="otk-path"
                rows={5}
                spellcheck={false}
                value={editor.state.values.startScript}
                onInput={(e) =>
                  editor.edit("startScript", e.currentTarget.value)}
              />
            </label>
            <div class="otk-project-startup-hints">
              <p>Runs when a new worktree is created.</p>
              <For each={editor.state.hints} keyed={(hint) => hint.variable}>
                {(hint) => (
                  <p>
                    <code>{hint().variable}</code>: {hint().description}
                  </p>
                )}
              </For>
            </div>
          </Show>
        </Form>
      </Show>
      <Show when={!editor.state.fields.length}>
        <FeedbackStatus
          feedback={{
            kind: "info",
            text: "This server has no writable project settings.",
          }}
        />
      </Show>
    </section>
  );
}

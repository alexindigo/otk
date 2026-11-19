// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ProjectEditField,
  ProjectEditSnapshot,
  ProjectEditTarget,
  ProjectPatch,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { type FailureValue, failureValue } from "./failure-features.ts";
export interface ProjectEditorState extends ProjectEditSnapshot {
  dirty: boolean;
  pending: boolean;
  reading: boolean;
  confirming: boolean;
  error: FailureValue;
}
export interface ProjectEditor {
  readonly state: ProjectEditorState;
  subscribe(listener: () => void): () => void;
  edit(field: ProjectEditField, value: string): void;
  image(read: () => Promise<string>): Promise<void>;
  sync(snapshot: ProjectEditSnapshot): void;
  save(): Promise<void>;
  dismiss(confirm?: () => boolean): boolean;
  keepEditing(): void;
  dispose(): void;
}
export function createProjectEditor(
  o: {
    snapshot: ProjectEditSnapshot;
    update(target: ProjectEditTarget, patch: ProjectPatch): Promise<void>;
    refresh(): Promise<ProjectEditSnapshot>;
    factory?: StateFactory;
  },
): ProjectEditor {
  const target = {
    directory: o.snapshot.directory,
    projectID: o.snapshot.projectID,
  };
  let saved = structuredClone(o.snapshot.values),
    alive = true,
    imageAttempt = 0;
  let work: Promise<void> | undefined, imageWork: Promise<void> | undefined;
  const revision = (o.factory ?? createState)({ value: 0 });
  let state: ProjectEditorState = {
    ...structuredClone(o.snapshot),
    dirty: false,
    pending: false,
    reading: false,
    confirming: false,
    error: "",
  };
  const publish = (patch: Partial<ProjectEditorState>) => {
    state = { ...state, ...patch };
    revision.update((draft) => {
      draft.value++;
    });
  };
  const model: ProjectEditor = {
    get state() {
      void revision.state.value;
      return state;
    },
    subscribe: (listener) => revision.subscribe(listener),
    edit(field, value) {
      if (!alive || !state.fields.includes(field)) return;
      if (field === "icon") {
        imageAttempt++;
        imageWork = undefined;
      }
      const values = { ...state.values, [field]: value };
      publish({
        values,
        dirty: state.fields.some((key) => values[key] !== saved[key]),
        error: "",
        ...(field === "icon" ? { reading: false } : {}),
      });
    },
    image(read) {
      const attempt = ++imageAttempt;
      const pending = Promise.resolve().then(async () => {
        try {
          const data = await read();
          if (alive && attempt === imageAttempt) model.edit("icon", data);
        } catch (cause) {
          if (alive && attempt === imageAttempt) {
            publish({
              error: failureValue(cause, {
                actionLabel: "Reading project icon",
                target: { directory: target.directory },
                reason: "The image could not be read.",
                recovery: "Choose the image again or use another image.",
              }),
            });
          }
        } finally {
          if (imageWork === pending) imageWork = undefined;
          if (alive && attempt === imageAttempt) publish({ reading: false });
        }
      });
      imageWork = pending;
      publish({ reading: true });
      return pending;
    },
    sync(snapshot) {
      if (
        !alive || snapshot.projectID !== target.projectID ||
        snapshot.directory !== target.directory
      ) return;
      const values = { ...state.values };
      for (const field of snapshot.fields) {
        if (values[field] === saved[field]) {
          values[field] = snapshot.values[field];
        }
      }
      saved = { ...snapshot.values };
      publish({
        ...snapshot,
        values,
        dirty: snapshot.fields.some((key) => values[key] !== saved[key]),
      });
    },
    save() {
      if (work) return work;
      if (imageWork) return imageWork.then(() => model.save());
      if (!alive || !state.dirty) return Promise.resolve();
      const values = { ...state.values };
      const patch: ProjectPatch = Object.fromEntries(
        state.fields.filter((field) => values[field] !== saved[field]).map((
          field,
        ) => [field, values[field]]),
      );
      work = Promise.resolve().then(async () => {
        try {
          await o.update(target, patch);
          const current = await o.refresh();
          if (!alive) return;
          // A late save acknowledges only captured input, never a subsequent edit.
          saved = { ...current.values };
          const next = { ...state.values };
          for (const field of state.fields) {
            if (next[field] === values[field]) {
              next[field] = current.values[field];
            }
          }
          publish({
            ...current,
            values: next,
            dirty: current.fields.some((field) => next[field] !== saved[field]),
          });
        } catch (cause) {
          if (alive) {
            publish({
              error: failureValue(cause, {
                actionLabel: "Saving project settings",
                target: {
                  directory: target.directory,
                  label: values.name || target.directory,
                },
                reason: "Project settings could not be saved.",
                recovery:
                  "Keep your changes and try saving again, or reopen settings to check native values.",
              }),
            });
          }
          throw cause;
        } finally {
          work = undefined;
          if (alive) publish({ pending: false });
        }
      });
      publish({ pending: true, error: "" });
      return work;
    },
    dismiss(confirm) {
      if (!state.dirty && !state.reading) return true;
      if (confirm) return confirm();
      publish({ confirming: true });
      return false;
    },
    keepEditing: () => publish({ confirming: false }),
    dispose() {
      alive = false;
    },
  };
  return model;
}

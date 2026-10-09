// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled, Show } from "solid-js";
import type { PromptPart } from "../../../protocol/rpc.ts";
import {
  type Chip,
  type Draft,
  type DraftChange,
  editDraft,
  editorSave,
  emptyDraft,
  insertChip,
  pasteLabel,
  serialize,
} from "./prompt/model.ts";
import { serverPath, upload } from "./prompt/attachments.ts";
import Chips from "./prompt/Chips.tsx";
import Editor from "./prompt/Editor.tsx";
import { summarizePaste } from "./prompt/paste.ts";
export default function Prompt(
  props: {
    value: Draft;
    connected: boolean;
    pasteSummary: boolean;
    onChange(value: DraftChange): Draft;
    onSubmit(parts: PromptPart[], mode: Draft["mode"]): Promise<void>;
    onFind(query: string): Promise<string[]>;
    onAbort(): Promise<void>;
  },
) {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(""),
    [armed, setArmed] = createSignal(false);
  let deadline = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let input!: HTMLTextAreaElement;
  const change = (update: DraftChange, caret?: number): Draft => {
    const draft = props.onChange(update);
    if (caret !== undefined) {
      requestAnimationFrame(() => {
        if (active && input.value === draft.input) {
          input.setSelectionRange(caret, caret);
        }
      });
    }
    return draft;
  };
  const files = async (items: File[]) => {
    if (!items.length) return;
    const uploads: { file: File; id: string }[] = [];
    let caret = input.selectionStart;
    const end = input.selectionEnd;
    const inserted = change((current) => {
      let draft = current;
      for (const [index, file] of items.entries()) {
        const label = file.type === "application/pdf"
          ? "PDF"
          : file.type.startsWith("image/")
          ? "Image"
          : "File";
        const count = draft.chips.filter((chip) =>
          chip.label.startsWith(`[${label} `)
        ).length + 1;
        const before = new Set(draft.chips.map((chip) => chip.id));
        draft = insertChip(
          draft,
          caret,
          index ? caret : end,
          `[${label} ${count}]`,
          {
            kind: "file",
            source: "upload",
            name: file.name,
            mime: file.type || "application/octet-stream",
            dataBase64: "",
          },
        );
        const chip = draft.chips.find((chip) => !before.has(chip.id))!;
        draft = {
          ...draft,
          chips: draft.chips.map((item) =>
            item.id === chip.id ? { ...item, pending: true } : item
          ),
        };
        uploads.push({ file, id: chip.id });
        caret = chip.end + 1;
      }
      return draft;
    });
    requestAnimationFrame(() => {
      if (active && input.value === inserted.input) {
        input.setSelectionRange(caret, caret);
      }
    });
    for (const { file, id } of uploads) {
      if (!active) return;
      const patch = (value: Partial<Chip>) =>
        change((current) =>
          current.chips.some((chip) => chip.id === id)
            ? {
              ...current,
              chips: current.chips.map((chip) =>
                chip.id === id ? { ...chip, ...value } : chip
              ),
            }
            : current
        );
      try {
        const part = await upload(file);
        if (!active) return;
        patch({ part, pending: false });
      } catch (error) {
        if (active) patch({ pending: false, error: (error as Error).message });
      }
    }
  };
  const paste = async (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    if (data.files.length) return files(Array.from(data.files));
    const text = data.getData("text/plain").replace(/\r\n?/g, "\n"),
      start = input.selectionStart,
      end = input.selectionEnd;
    const summarized = summarizePaste(text, props.pasteSummary);
    const draft = change(
      (current) =>
        summarized
          ? insertChip(current, start, end, pasteLabel(text.trim()), {
            kind: "text",
            text: text.trim(),
          })
          : editDraft(
            current,
            current.input.slice(0, start) + text + current.input.slice(end),
          ),
      start + (summarized ? pasteLabel(text.trim()).length + 1 : text.length),
    );
    try {
      const path = serverPath(text),
        matches = path ? await props.onFind(path) : [];
      if (!active) return;
      if (path && matches.includes(path)) {
        change(
          (current) =>
            current === draft
              ? insertChip(current, start, start + text.length, `@${path}`, {
                kind: "file",
                source: "path",
                path,
              })
              : current,
          start + path.length + 2,
        );
      }
    } catch (error) {
      if (active && change((current) => current) === draft) {
        setError((error as Error).message);
      }
    }
  };
  const submit = async () => {
    const draft = change((current) => current);
    if (draft.mode === "normal" && /^\/editor(?:\s|$)/.test(draft.input)) {
      change((current) => {
        if (current !== draft) return current;
        const edited = editDraft(
          current,
          current.input.replace(/^\/editor\s?/, ""),
        );
        return { ...edited, editor: { text: edited.input } };
      });
      return;
    }
    if (
      !draft.input.trim() || !props.connected || pending() ||
      draft.chips.some((chip) => chip.pending || chip.error)
    ) return;
    setPending(true);
    setError("");
    try {
      await props.onSubmit(serialize(draft), draft.mode);
      if (active) {
        change((current) => current === draft ? emptyDraft() : current);
      }
    } catch (error) {
      if (active && change((current) => current) === draft) {
        setError((error as Error).message);
      }
    } finally {
      if (active) setPending(false);
    }
  };
  const escape = async (event: KeyboardEvent) => {
    if (
      event.key !== "Escape" || event.defaultPrevented || props.value.editor ||
      !props.connected
    ) {
      return;
    }
    event.preventDefault();
    if (Date.now() < deadline) {
      deadline = 0;
      clearTimeout(timer);
      setArmed(false);
      try {
        await props.onAbort();
      } catch (error) {
        setError((error as Error).message);
      }
    } else {
      deadline = Date.now() + 5000;
      setArmed(true);
      timer = setTimeout(() => {
        deadline = 0;
        setArmed(false);
      }, 5000);
    }
  };
  onSettled(() => {
    document.addEventListener("keydown", escape);
    return () => {
      active = false;
      document.removeEventListener("keydown", escape);
      clearTimeout(timer);
    };
  });
  return (
    <form
      class="otk-prompt"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void files(Array.from(event.dataTransfer?.files || []));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label for="otk-prompt-input">
        {props.value.mode === "shell" ? "Shell" : "Prompt"}
      </label>
      <Chips
        chips={props.value.chips}
        onOpen={(chip) =>
          chip.part.kind === "text"
            ? change((current) => {
              const found = current.chips.find((value) => value.id === chip.id);
              return found?.part.kind === "text"
                ? {
                  ...current,
                  editor: { chipID: found.id, text: found.part.text },
                }
                : current;
            })
            : input.focus()}
        onRemove={(chip) =>
          change((current) => {
            const found = current.chips.find((item) => item.id === chip.id);
            return found
              ? editDraft(
                current,
                current.input.slice(0, found.start) +
                  current.input.slice(found.end),
              )
              : current;
          })}
      />
      <textarea
        ref={(element) => {
          input = element;
        }}
        id="otk-prompt-input"
        name="prompt"
        placeholder={props.value.mode === "shell"
          ? "Run a shell command…"
          : "Message the agent…"}
        value={props.value.input}
        onPaste={(event) => void paste(event)}
        onInput={(event) => {
          const value = event.currentTarget.value;
          change((current) => editDraft(current, value));
        }}
        onKeyDown={(event) => {
          if (
            event.key === "!" && !event.isComposing &&
            props.value.mode === "normal" &&
            event.currentTarget.selectionStart === 0 &&
            event.currentTarget.selectionEnd === 0
          ) {
            event.preventDefault();
            event.stopPropagation();
            change((current) => ({ ...current, mode: "shell" }));
            return;
          }
          if (
            props.value.mode === "shell" &&
            (event.key === "Escape" ||
              (event.key === "Backspace" &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0))
          ) {
            event.preventDefault();
            event.stopPropagation();
            change((current) => ({ ...current, mode: "normal" }));
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div class="otk-prompt-actions">
        <button
          type="button"
          onClick={() =>
            change((current) => ({
              ...current,
              editor: { text: current.input },
            }))}
        >
          Edit prompt
        </button>
        <span class="otk-muted">
          {armed()
            ? "esc again to interrupt"
            : "Enter to send · Shift+Enter for newline · Esc twice to interrupt"}
        </span>
        <button
          type="submit"
          disabled={pending() ||
            props.value.chips.some((chip) => chip.pending || chip.error) ||
            !props.connected || !props.value.input.trim()}
        >
          Send
        </button>
      </div>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
      <Show when={props.value.editor}>
        {(editor) => (
          <Editor
            title={editor().chipID ? "Edit pasted text" : "Edit prompt"}
            value={editor().text}
            onChange={(text) =>
              change((current) =>
                current.editor
                  ? ({ ...current, editor: { ...current.editor, text } })
                  : current
              )}
            onSave={() => {
              change(editorSave);
              input.focus();
            }}
            onCancel={() => {
              change((current) => ({ ...current, editor: undefined }));
              input.focus();
            }}
          />
        )}
      </Show>
    </form>
  );
}

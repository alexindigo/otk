// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
const fields = [
  "",
  "unknown",
  "text",
  "SEARCH",
  "tel",
  "url",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
];
const compact = [
  "checkbox",
  "RADIO",
  "range",
  "color",
  "file",
  "button",
  "submit",
  "reset",
  "image",
];
export default function Controls() {
  return (
    <section data-native-controls style={{ width: "320px" }}>
      <For each={fields}>
        {(type, i) => <input data-field={i()} type={type || undefined} />}
      </For>
      <textarea data-field="area" />
      <select data-field="select">
        <option>Choice</option>
      </select>
      <For each={compact}>
        {(type, i) => (
          <label
            data-native-row={i()}
            style={{ display: "flex", "align-items": "center", gap: "10px" }}
          >
            <input
              data-compact={i()}
              type={type}
              alt={type === "image" ? "Image" : undefined}
              src={type === "image"
                ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3C/svg%3E"
                : undefined}
            />
            <span>Pick</span>
          </label>
        )}
      </For>
      <input type="hidden" />
      <div id="native-reference" />
      <button type="button" id="hidden-action" class="otk-pill" hidden>
        Unavailable action
      </button>
      <div id="hidden-group" class="otk-control-row" hidden>
        <button type="button">Unavailable group</button>
      </div>
    </section>
  );
}

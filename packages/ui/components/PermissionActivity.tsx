// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type {
  PermissionActivity as Activity,
  PermissionActivityPage,
} from "@otk/protocol";
import PermissionSummary from "./PermissionSummary.tsx";
import "./PermissionActivity.css" with { type: "text" };

const action = (entry: Activity) =>
  entry.reply === "reject"
    ? "Reject"
    : entry.reply === "always"
    ? "Allow always"
    : "Allow once";
export default function PermissionActivity(props: {
  value: PermissionActivityPage & { loading: boolean; error?: string };
  title(sessionID: string): string;
  onMore(): Promise<void>;
  onRetry(): Promise<void>;
}) {
  return (
    <section class="otk-permission-activity" aria-label="Permission activity">
      <Show when={props.value.loading}>
        <p class="otk-muted" role="status">Loading activity…</p>
      </Show>
      <Show when={props.value.error}>
        <p role="alert" class="otk-error">{props.value.error}</p>
        <button
          type="button"
          onClick={() =>
            void props.onRetry()}
        >
          Retry activity
        </button>
      </Show>
      <Show
        when={!props.value.loading && !props.value.entries.length &&
          !props.value.error}
      >
        <p class="otk-muted">Permission replies will appear here.</p>
      </Show>
      <ol>
        <For
          each={props.value.entries}
          keyed={(entry) =>
            entry.id}
        >
          {(entry) => (
            <li data-activity={entry().id}>
              <header>
                <strong>
                  {entry().source === "auto" ? "Auto" : "Manual"} ·{" "}
                  {action(entry())}
                </strong>
                <time datetime={new Date(entry().time).toISOString()}>
                  {new Date(entry().time).toLocaleTimeString()}
                </time>
              </header>
              <p class="otk-muted">{props.title(entry().request.sessionID)}</p>
              <PermissionSummary request={entry().request} />
              <p
                class={entry().outcome === "failed" ? "otk-error" : "otk-muted"}
              >
                {entry().outcome === "confirmed"
                  ? (entry().reply === "reject" ? "Rejected" : "Allowed")
                  : entry().outcome === "failed"
                  ? `Reply failed: ${entry().error}`
                  : "Reply started; outcome not confirmed"}
              </p>
              <Show when={entry().message}>
                <p>{entry().message}</p>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={props.value.before && !props.value.loading}>
        <button type="button" onClick={() => void props.onMore()}>
          Load earlier activity
        </button>
      </Show>
    </section>
  );
}

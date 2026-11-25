// SPDX-License-Identifier: LGPL-3.0-only
import "./PermissionSummary.css" with { type: "text" };
import CodeBlock from "./CodeBlock.tsx";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import DisclosureToggle from "./DisclosureToggle.tsx";
import type { PermissionDetail, PermissionRequest } from "@otk/protocol";

const detailOf = <K extends PermissionDetail["kind"]>(
  detail: PermissionDetail,
  kind: K,
) =>
  detail.kind === kind ? detail as PermissionDetail & { kind: K } : undefined;

/** The exact action and requested scope, shared by every approval surface. */
export default function PermissionSummary(
  props: { request: PermissionRequest; compact?: boolean },
) {
  const [scope, setScope] = createSignal(false);
  if (props.compact) {
    const target = () => {
      const detail = props.request.detail;
      return detail.kind === "bash"
        ? [detail.command, detail.cwd].filter(Boolean).join(" | ")
        : detail.kind === "edit"
        ? detail.files.map((file) => file.path).join(", ")
        : detail.summary;
    };
    return (
      <div class="otk-permission-summary otk-permission-compact">
        <span class="otk-permission-kind">{props.request.kind}</span>
        <span class="otk-control-label otk-path" title={target()}>
          {target()}
        </span>
      </div>
    );
  }
  return (
    <div class="otk-permission-summary">
      <span class="otk-permission-kind">{props.request.kind}</span>
      <Switch>
        <Match when={detailOf(props.request.detail, "bash")}>
          {(detail) => (
            <>
              <CodeBlock
                source={{ kind: "request", text: detail().command }}
                textClass="otk-permission-command"
              />
              <Show when={detail().cwd}>
                <p class="otk-muted otk-path">{detail().cwd}</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={detailOf(props.request.detail, "edit")}>
          {(detail) => (
            <ul>
              <For each={detail().files} keyed={(file) => file.path}>
                {(file) => (
                  <li>
                    <span class="otk-path">{file().path}</span>{" "}
                    <span class="otk-muted">
                      +{file().additions} / −{file().deletions}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Match>
        <Match when={detailOf(props.request.detail, "generic")}>
          {(detail) => <p>{detail().summary}</p>}
        </Match>
      </Switch>
      <div class="otk-permission-patterns">
        <DisclosureToggle
          class="otk-permission-scope"
          label="Requested scope"
          open={scope()}
          onOpen={setScope}
        >
          <span class="otk-control-label">Requested scope</span>
        </DisclosureToggle>
        <Show when={scope()}>
          <ul>
            <For each={props.request.patterns} keyed={false}>
              {(pattern) => <li class="otk-path">{pattern()}</li>}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

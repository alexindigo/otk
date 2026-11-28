// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { toggle } from "../../components/selection.ts";
import { ShieldCheckIcon } from "../../components/ChromeIcons.tsx";
import "./approvals.css" with { type: "text" };

export function registerAutoApprovePrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "session-auto-approve",
    create(ctx) {
      const ready = () => !!ctx.approvals?.state.ready;
      const target = () => {
        const family = ctx.approvalTarget?.();
        return family?.sessionID === ctx.sessionID() ? undefined : family;
      };
      const on = () => !!ctx.approvals?.owner(ctx.sessionID());
      const scope = () => {
        const value = target();
        return value && value.sessionID !== ctx.sessionID() && value.title
          ? `${value.title} and its helpers`
          : "this session and its helpers";
      };
      return {
        settingsFace: () => (
          <Show when={ready()}>
            <span class="otk-icon-button" />
          </Show>
        ),
        settings: () => (
          <Show when={ready()}>
            <button
              type="button"
              {...toggle({
                class: "otk-auto-approve-toggle otk-icon-button",
                on: on(),
              })}
              aria-label="Auto-approve"
              aria-description={target() ? `Applies to ${scope()}` : undefined}
              title={`Auto-approve ${
                on() ? "on" : "off"
              }: allow every permission request once for ${scope()}, including with no browser open`}
              onClick={() =>
                void ctx.commands.run("permission.auto", target()).catch(
                  ctx.fail,
                )}
            >
              <ShieldCheckIcon />
            </button>
          </Show>
        ),
      };
    },
  });
}

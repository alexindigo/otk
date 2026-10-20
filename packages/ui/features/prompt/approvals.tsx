// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { selection } from "../../components/selection.ts";
import SelectionContent from "../../components/SelectionContent.tsx";
import { ShieldCheckIcon } from "../../components/ChromeIcons.tsx";
import "./approvals.css" with { type: "text" };

export function registerAutoApprovePrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "session-auto-approve",
    create(ctx) {
      return {
        settings: () => (
          <Show when={ctx.approvals?.state.ready}>
            <button
              type="button"
              data-otk-selection="horizontal"
              {...selection({
                class: "otk-auto-approve-toggle otk-icon-button",
                kind: "pressed",
                selected: !!ctx.approvals?.owner(ctx.sessionID()),
              })}
              aria-label="Auto-approve"
              title={`Auto-approve ${
                ctx.approvals?.owner(ctx.sessionID()) ? "on" : "off"
              }: allow every permission request once for this session and its helpers, including with no browser open`}
              onClick={() =>
                void ctx.commands.run("permission.auto").catch(ctx.fail)}
            >
              <SelectionContent>
                <ShieldCheckIcon />
              </SelectionContent>
            </button>
          </Show>
        ),
      };
    },
  });
}

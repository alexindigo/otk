// SPDX-License-Identifier: LGPL-3.0-only
import "./SubagentBar.css" with { type: "text" };
import { Show } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
export default function SubagentBar(
  props: {
    available: boolean;
    onMove(delta: number): void | Promise<void>;
  },
) {
  const ports = useCommandPorts();
  const previous = ownedCommand(ports, {
    id: "subagent.previous",
    title: "Previous subagent",
    category: "Session",
    enabled: () => props.available,
    run: () => props.onMove(-1),
  });
  const next = ownedCommand(ports, {
    id: "subagent.next",
    title: "Next subagent",
    category: "Session",
    enabled: () => props.available,
    run: () => props.onMove(1),
  });
  return (
    <Show when={props.available}>
      <nav class="otk-subagent-bar" aria-label="Subagent siblings">
        <button type="button" onClick={() => void previous()}>
          Prev
        </button>
        <button type="button" onClick={() => void next()}>
          Next
        </button>
      </nav>
    </Show>
  );
}

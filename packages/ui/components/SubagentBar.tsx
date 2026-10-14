// SPDX-License-Identifier: LGPL-3.0-only
import "./SubagentBar.css" with { type: "text" };
import type { ContentSession } from "@otk/protocol";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
export default function SubagentBar(
  props: {
    info: ContentSession;
    siblings: ContentSession[];
    onOpen(id: string): void;
  },
) {
  const move = (delta: number) => {
    const at = props.siblings.findIndex((s) => s.id === props.info.id),
      n = props.siblings.length;
    if (n) props.onOpen(props.siblings[(at + delta + n) % n].id);
  };
  const ports = useCommandPorts();
  const parent = ownedCommand(ports, {
    id: "subagent.parent",
    title: "Parent session",
    category: "Session",
    run: () => {
      if (props.info.parentID) props.onOpen(props.info.parentID);
    },
  });
  const previous = ownedCommand(ports, {
    id: "subagent.previous",
    title: "Previous subagent",
    category: "Session",
    enabled: () => !!props.siblings.length,
    run: () => move(-1),
  });
  const next = ownedCommand(ports, {
    id: "subagent.next",
    title: "Next subagent",
    category: "Session",
    enabled: () => !!props.siblings.length,
    run: () => move(1),
  });
  return (
    <nav class="otk-subagent-bar" aria-label="Subagent navigation">
      <strong>Subagent: {props.info.title}</strong>
      <div>
        <button
          type="button"
          onClick={() => void parent()}
        >
          Parent
        </button>
        <button
          type="button"
          disabled={!props.siblings.length}
          onClick={() => void previous()}
        >
          Prev
        </button>
        <button
          type="button"
          disabled={!props.siblings.length}
          onClick={() => void next()}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

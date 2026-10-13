// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "@otk/protocol";
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
  return (
    <nav class="otk-subagent-bar" aria-label="Subagent navigation">
      <strong>Subagent: {props.info.title}</strong>
      <div>
        <button
          type="button"
          onClick={() =>
            props.info.parentID && props.onOpen(props.info.parentID)}
        >
          Parent
        </button>
        <button
          type="button"
          disabled={!props.siblings.length}
          onClick={() => move(-1)}
        >
          Prev
        </button>
        <button
          type="button"
          disabled={!props.siblings.length}
          onClick={() => move(1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

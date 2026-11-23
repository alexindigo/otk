// SPDX-License-Identifier: LGPL-3.0-only
import { type EntityStateStore, sessionEvidence } from "@otk/client";
import { Show } from "solid-js";
import ChromeMeta from "./ChromeMeta.tsx";

/** The two session lists present the same owner facts with explicit scope. */
export default function SessionStateMeta(
  props: { entities: EntityStateStore; entityKey: string },
): import("solid-js").Element {
  const evidence = () => sessionEvidence(props.entities, props.entityKey);
  return (
    <>
      <Show when={evidence()?.retry}>
        {(retry) => <ChromeMeta>retry {retry().attempt}</ChromeMeta>}
      </Show>
      <Show when={evidence()?.permissions}>
        {(count) => (
          <ChromeMeta title="This session's pending permissions">
            P {count()}
          </ChromeMeta>
        )}
      </Show>
      <Show when={evidence()?.questions}>
        {(count) => (
          <ChromeMeta
            title="This session's pending questions"
            aria-label="Pending questions"
          >
            Q {count()}
          </ChromeMeta>
        )}
      </Show>
      <Show when={evidence()?.descendants.blocked}>
        {(count) => (
          <ChromeMeta
            title="Child sessions needing you"
            aria-label={`Child sessions needing you: ${count()}`}
          >
            Children {count()}
          </ChromeMeta>
        )}
      </Show>
      <Show when={evidence()?.failure || evidence()?.error}>
        <ChromeMeta
          title="The agent reported a session failure"
          aria-label="Session error"
        >
          Error
        </ChromeMeta>
      </Show>
    </>
  );
}

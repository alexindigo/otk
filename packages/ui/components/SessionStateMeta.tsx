// SPDX-License-Identifier: LGPL-3.0-only
import { type EntityStateStore, sessionEvidence } from "@otk/client";
import { Show } from "solid-js";
import ChromeMeta, { MetaItem } from "./ChromeMeta.tsx";
import { DelegateIcon } from "./ChromeIcons.tsx";

/** The two session lists present the same owner facts with explicit scope. */
export default function SessionStateMeta(
  props: { entities: EntityStateStore; entityKey: string },
): import("solid-js").Element {
  const evidence = () => sessionEvidence(props.entities, props.entityKey);
  return (
    <>
      <Show when={evidence()?.retry}>
        {(retry) => (
          <MetaItem rank={5}>
            <ChromeMeta>retry {retry().attempt}</ChromeMeta>
          </MetaItem>
        )}
      </Show>
      <Show when={evidence()?.permissions}>
        {(count) => (
          <MetaItem rank={1} title="This session's pending permissions">
            <ChromeMeta>P {count()}</ChromeMeta>
          </MetaItem>
        )}
      </Show>
      <Show when={evidence()?.questions}>
        {(count) => (
          <MetaItem
            rank={2}
            title="This session's pending questions"
            aria-label="Pending questions"
          >
            <ChromeMeta>Q {count()}</ChromeMeta>
          </MetaItem>
        )}
      </Show>
      <Show when={evidence()?.descendants.blocked}>
        {(count) => (
          <MetaItem
            rank={3}
            title="Child sessions needing you"
            aria-label={`Child sessions needing you: ${count()}`}
            compact={
              <>
                <DelegateIcon />
                {count()}
              </>
            }
          >
            <ChromeMeta>Children {count()}</ChromeMeta>
          </MetaItem>
        )}
      </Show>
      <Show when={evidence()?.failure || evidence()?.error}>
        <MetaItem
          rank={4}
          title="The agent reported a session failure"
          aria-label="Session error"
        >
          <ChromeMeta>Error</ChromeMeta>
        </MetaItem>
      </Show>
    </>
  );
}

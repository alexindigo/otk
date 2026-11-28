// SPDX-License-Identifier: LGPL-3.0-only
import "./DeletedSession.css" with { type: "text" };
import type { Draft, DraftRecovery } from "@otk/client";
import ComposerNotice from "./ComposerNotice.tsx";
import DraftRecoveryNotice from "./DraftRecoveryNotice.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import { For, Show } from "solid-js";
/** Retained facts and local/user-metadata actions only. */
export default function DeletedSession(props: {
  title: string;
  ref?(element: HTMLElement): void;
  notice: string;
  facts: { label: string; value: string; description?: string }[];
  draftNotice?: string;
  draft?: Draft;
  recoveries?: readonly DraftRecovery[];
  retained?: { owner: string; value: string }[];
  copy(): void;
  remove?: () => void;
  close?: () => void;
}): import("solid-js").Element {
  return (
    <ScrollRegion
      as="section"
      ref={props.ref}
      class="otk-deleted-session"
      aria-label="Deleted session"
    >
      <h1>{props.title}</h1>
      <p>{props.notice}</p>
      <Show when={props.draftNotice}>
        <p role="status">{props.draftNotice}</p>
      </Show>
      <Show when={props.recoveries?.length}>
        <ComposerNotice>
          <For each={props.recoveries}>
            {(recovery) => <DraftRecoveryNotice recovery={recovery} />}
          </For>
        </ComposerNotice>
      </Show>
      <Show when={props.draft?.input}>
        {(text) => (
          <label class="otk-deleted-draft">
            Unsent draft
            <textarea readonly value={text()} />
          </label>
        )}
      </Show>
      <Show when={props.draft?.editor?.text}>
        {(text) => (
          <label class="otk-deleted-draft">
            Unsent editor text
            <textarea readonly value={text()} />
          </label>
        )}
      </Show>
      <For each={props.retained ?? []} keyed={(input) => input.owner}>
        {(input) => (
          <section aria-label={`Unsent ${input().owner} input`}>
            <h2>Unsent {input().owner} input</h2>
            <p>{input().value}</p>
          </section>
        )}
      </For>
      <dl>
        <For each={props.facts} keyed={(fact) => fact.label}>
          {(fact) => (
            <div>
              <dt>{fact().label}</dt>
              <dd aria-description={fact().description}>{fact().value}</dd>
            </div>
          )}
        </For>
      </dl>
      <div class="otk-control-row">
        <button type="button" onClick={props.copy}>Copy title</button>
        <Show when={props.remove}>
          <button type="button" onClick={() => props.remove?.()}>
            Remove from task
          </button>
        </Show>
        <Show when={props.close}>
          <button type="button" onClick={() => props.close?.()}>
            Close session
          </button>
        </Show>
      </div>
    </ScrollRegion>
  );
}

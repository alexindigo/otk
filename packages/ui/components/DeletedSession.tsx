// SPDX-License-Identifier: LGPL-3.0-only
import "./DeletedSession.css" with { type: "text" };
import { For, Show } from "solid-js";
/** Retained facts and local/user-metadata actions only. */
export default function DeletedSession(props: {
  title: string;
  ref?(element: HTMLElement): void;
  notice: string;
  facts: { label: string; value: string; description?: string }[];
  draftNotice?: string;
  retained?: { owner: string; value: string }[];
  copy(): void;
  remove?: () => void;
  close?: () => void;
}): import("solid-js").Element {
  return (
    <section
      ref={props.ref}
      class="otk-deleted-session"
      aria-label="Deleted session"
    >
      <h1>{props.title}</h1>
      <p>{props.notice}</p>
      <Show when={props.draftNotice}>
        <p role="status">{props.draftNotice}</p>
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
    </section>
  );
}

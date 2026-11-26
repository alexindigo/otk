// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import {
  type ActionControl,
  type ContextTarget,
  hashFor,
  type SessionRename,
  type TrailCrumb,
  type TrailModel,
} from "@otk/client";
import type { SessionContextTarget } from "../features/session-context.ts";
import OverflowRow from "./OverflowRow.tsx";
import StatusLight from "./StatusLight.tsx";
import TitleEditor from "./TitleEditor.tsx";
import { MAX_SESSION_TITLE } from "@otk/protocol";
import { ChevronIcon } from "./ChromeIcons.tsx";
import { location } from "./selection.ts";
import { contextTarget } from "./context-target.ts";
import ActionButton from "./ActionButton.tsx";
import { nativeAttributes } from "./native-attributes.ts";
import { breadcrumbRows } from "./list-presentation.ts";
import "./TaskTrail.css" with { type: "text" };

/** D67: data-only ancestry navigation. No sub-session inventory lives here. */
export default function TaskTrail(props: {
  model: TrailModel;
  selected?: string;
  sidecarId: string;
  title(id: string): string;
  tooltip(id: string): string;
  target(id: string): ContextTarget<SessionContextTarget>;
  openAction(id: string): ActionControl;
  rename?: SessionRename;
  feedbackID: string;
}) {
  const editing = (id: string) =>
    props.rename?.matches(
      { sidecarId: props.sidecarId, sessionID: id },
      "chip",
    );
  const compactTitle = (title: string, measure = false) => {
    const at = title.search(/\s/),
      first = at < 0 ? title : title.slice(0, at),
      tail = at < 0 ? "" : title.slice(at).trim();
    const omission = " ... ";
    return (
      <span class="otk-trail-compact-title">
        <span class="otk-trail-first">{first}</span>
        <Show when={tail}>
          <span class="otk-trail-ellipsis">{omission}</span>
          <span class="otk-trail-tail">
            <span>{measure ? tail.slice(-1) : tail}</span>
          </span>
        </Show>
      </span>
    );
  };
  const rows = () => breadcrumbRows(props.model.crumbs);
  const separator = (first: boolean) => (
    <Show when={!first}>
      <span class="otk-trail-separator">
        <ChevronIcon />
      </span>
    </Show>
  );
  const place = (row: TrailCrumb) =>
    location({
      class: "otk-trail-session otk-session-crumb",
      current: row.id === props.selected,
    });
  const crumbContent = (row: () => TrailCrumb, title: Element) => (
    <>
      <StatusLight small state={row().status} />
      {title}
    </>
  );
  // Keep reads inside the mounted label: the fit snapshot can refresh during
  // a pointer gesture without replacing the browser's pressed text node.
  const label = (
    row: () => TrailCrumb,
    compact: () => boolean,
    measure = false,
  ) =>
    crumbContent(
      row,
      <span class="otk-trail-title otk-crumb-title">
        <Show when={compact()} fallback={props.title(row().id)}>
          {compactTitle(props.title(row().id), measure)}
        </Show>
      </span>,
    );
  const measure = (row: TrailCrumb & { first: boolean }, compact: boolean) => {
    const readRow = () => row;
    const readCompact = () => compact;
    return (
      <span class="otk-trail-measure">
        {separator(row.first)}
        <span class={place(row).class}>
          {label(readRow, readCompact, true)}
        </span>
      </span>
    );
  };
  return (
    <div class="otk-trail">
      <OverflowRow<TrailCrumb & { key: string; first: boolean }>
        singleLine
        items={rows()}
        required={rows().map((row) => row.id)}
        reveal={rows().find((row) => editing(row.id))?.id ?? props.selected}
        uncompacted={rows().filter((row) => editing(row.id)).map((row) =>
          row.id
        )}
        measure={(row) => measure(row, false)}
        compactMeasure={(row) => measure(row, true)}
        more={() => null}
      >
        {(row: () => TrailCrumb & { key: string; first: boolean }, compact) => {
          const target = contextTarget(() => props.target(row().id));
          const attributes = () => ({
            "data-crumb": row().id,
            "data-depth": row().depth,
            "data-helper": String(row().helper),
            "data-crumb-kind": row().kind,
          });
          const native = nativeAttributes(() => ({
            ...attributes(),
            ...place(row()),
          }));
          return (
            <span class="otk-trail-link">
              {separator(row().first)}
              <Show
                when={editing(row().id)}
                fallback={
                  <ActionButton
                    action={props.openAction(row().id)}
                    href={hashFor({
                      sidecarId: props.sidecarId,
                      sessionID: row().id,
                    })}
                    ref={target}
                    location={place(row())}
                    attributes={attributes()}
                    title={props.tooltip(row().id)}
                    label={props.title(row().id)}
                  >
                    {label(row, compact)}
                  </ActionButton>
                }
              >
                <div
                  {...native.attributes}
                  ref={[target, native.ref]}
                  title={props.tooltip(row().id)}
                  aria-label={props.title(row().id)}
                >
                  {crumbContent(
                    row,
                    <TitleEditor
                      label="Rename session"
                      pendingText="Renaming session..."
                      maxLength={MAX_SESSION_TITLE}
                      owner={props.rename!}
                      feedbackID={props.feedbackID}
                    />,
                  )}
                </div>
              </Show>
            </span>
          );
        }}
      </OverflowRow>
    </div>
  );
}

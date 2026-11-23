// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import { dynamic } from "@solidjs/web";
import {
  type ContextTarget,
  hashFor,
  type SessionRename,
  type TrailCrumb,
  type TrailModel,
} from "@otk/client";
import type { SessionContextTarget } from "../features/session-context.ts";
import OverflowRow from "./OverflowRow.tsx";
import StatusLight from "./StatusLight.tsx";
import SelectionContent from "./SelectionContent.tsx";
import TitleEditor from "./TitleEditor.tsx";
import { ChevronIcon } from "./ChromeIcons.tsx";
import { selection } from "./selection.ts";
import { contextTarget } from "./context-target.ts";
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
  open(id: string): void;
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
        measure={(row: TrailCrumb & { first: boolean }) => (
          <span class="otk-trail-measure">
            {separator(row.first)}
            <span
              class="otk-trail-session otk-selection-item"
              data-otk-selection="horizontal"
            >
              <SelectionContent
                leading={<StatusLight small state={row.status} />}
              >
                {props.title(row.id)}
              </SelectionContent>
            </span>
          </span>
        )}
        compactMeasure={(row: TrailCrumb & { first: boolean }) => (
          <span class="otk-trail-measure">
            {separator(row.first)}
            <span
              class="otk-trail-session otk-selection-item"
              data-otk-selection="horizontal"
            >
              <SelectionContent
                leading={<StatusLight small state={row.status} />}
              >
                {compactTitle(props.title(row.id), true)}
              </SelectionContent>
            </span>
          </span>
        )}
        more={() => null}
      >
        {(row: () => TrailCrumb & { key: string; first: boolean }, compact) => {
          const Control = dynamic(() => editing(row().id) ? "div" : "a");
          const native = nativeAttributes(() => ({
            onClick: (event: MouseEvent) => {
              if (
                editing(row().id) || event.button !== 0 || event.ctrlKey ||
                event.metaKey || event.shiftKey || event.altKey
              ) return;
              event.preventDefault();
              props.open(row().id);
            },
          }));
          return (
            <span class="otk-trail-link">
              {separator(row().first)}
              <Control
                href={hashFor({
                  sidecarId: props.sidecarId,
                  sessionID: row().id,
                })}
                ref={[contextTarget(() => props.target(row().id)), native.ref]}
                {...native.attributes}
                {...selection({
                  class: "otk-trail-session otk-session-crumb",
                  kind: "current",
                  selected: row().id === props.selected,
                })}
                data-otk-selection="horizontal"
                data-crumb={row().id}
                data-depth={row().depth}
                data-helper={String(row().helper)}
                data-crumb-kind={row().kind}
                title={props.tooltip(row().id)}
                aria-label={props.title(row().id)}
              >
                <SelectionContent
                  leading={<StatusLight small state={row().status} />}
                >
                  <Show
                    when={editing(row().id)}
                    fallback={
                      <span class="otk-trail-title otk-crumb-title">
                        <Show when={compact()} fallback={props.title(row().id)}>
                          {compactTitle(props.title(row().id))}
                        </Show>
                      </span>
                    }
                  >
                    <TitleEditor
                      owner={props.rename!}
                      feedbackID={props.feedbackID}
                    />
                  </Show>
                </SelectionContent>
              </Control>
            </span>
          );
        }}
      </OverflowRow>
    </div>
  );
}

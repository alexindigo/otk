// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ActionControl,
  elapsed,
  metaList,
  type TranscriptReply,
  unknownTime,
  workLogBookkeeping,
} from "@otk/client";
import type {
  Activity,
  Part,
  PermissionRequest,
  Preferences,
} from "@otk/protocol";
import {
  createEffect,
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { transcriptDisclosureIdentity } from "../features/transcript-context.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import type { PartRowSlots } from "../registries/renderers.ts";
import ActivityIndicator from "./ActivityIndicator.tsx";
import ActionButton from "./ActionButton.tsx";
import { WorkLogIcon } from "./ChromeIcons.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import Disclosure from "./Disclosure.tsx";
import PartsView from "./PartsView.tsx";
import RecordKinds, { useRecordKindsRegion } from "./RecordKinds.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import { selection } from "./selection.ts";
import TimeText from "./TimeText.tsx";
import TimeValue from "./TimeValue.tsx";
import { TreeNode } from "./Tree.tsx";
import type { WorkRun, WorkRuns } from "./work-log.ts";

function WorkTimeBar(
  props: { run: WorkRun; start: number; end: number; now: number },
): Element {
  const start = () => props.run.start;
  const end = () => props.run.live ? props.now : props.run.end;
  const position = (time: number) =>
    (100 * (time - props.start)) / (props.end - props.start);
  return (
    <svg
      class="otk-work-axis"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect class="otk-work-axis-track" width="100" height="6" rx="3" />
      <Show
        when={start() !== undefined && end() !== undefined &&
          props.start < props.end}
      >
        <Show when={props.run.thinkingMs}>
          {(duration) => (
            <rect
              class="otk-work-axis-thought"
              x={position(start()! - duration())}
              width={position(start()!) - position(start()! - duration())}
              height="6"
            />
          )}
        </Show>
        <rect
          class="otk-work-axis-run"
          x={position(start()!)}
          width={Math.max(0, position(end()!) - position(start()!))}
          height="6"
          rx="3"
        />
      </Show>
    </svg>
  );
}

function RecordedParts(props: { children: Element }): Element {
  return <div id={useRecordKindsRegion()}>{props.children}</div>;
}

export default function WorkRunList(props: {
  work: WorkRuns;
  reply: TranscriptReply;
  selected?: string;
  prefs: Preferences;
  directory?: string;
  permissions: PermissionRequest[];
  streaming: boolean;
  onOpenChild(id: string): void;
  childAction(id: string): ActionControl;
  onFeedback: NonNullable<Parameters<typeof ActionButton>[0]["onFeedback"]>;
}): Element {
  const { parts, tools } = useUiRegistries();
  const identify = transcriptDisclosureIdentity();
  const byID = createMemo(() =>
    new Map(props.reply.message.parts.map((part) => [part.id, part]))
  );
  const sourceIDs = createMemo(() =>
    new Map(
      props.reply.segments.flatMap(({ messageID, parts }) =>
        parts.map(({ id }) => [id, messageID] as const)
      ),
    )
  );
  const resolve = (ids?: readonly string[]) =>
    (ids ?? []).flatMap((id) => {
      const part = byID().get(id);
      return part ? [part] : [];
    });
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => !!props.work.live, (active) => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const axis = createMemo(() => {
    let start = Infinity, end = -Infinity;
    for (const run of props.work.runs) {
      if (run.start !== undefined) {
        start = Math.min(start, run.start - (run.thinkingMs ?? 0));
      }
      if (run.end !== undefined) end = Math.max(end, run.end);
      if (run.live) end = Math.max(end, now());
    }
    return { start, end };
  });
  const partView = (items: Part[], row?: PartRowSlots, after?: boolean) => (
    <PartsView
      parts={items}
      row={row}
      after={after}
      tree
      user={false}
      streaming={props.streaming}
      prefs={props.prefs}
      directory={props.directory}
      permissions={props.permissions}
      onOpenChild={props.onOpenChild}
      sourceID={(part) => sourceIDs().get(part.id) ?? props.reply.firstID}
    />
  );
  const bookkeeping = (part: Part): Activity | undefined => {
    const kind = workLogBookkeeping(part);
    if (!kind) return;
    const original = parts.presentation(part, props.prefs).activity;
    return {
      ...original,
      kindLabel: "Record",
      title: original?.title ?? "Record",
      layout: "row",
      tone: "normal",
      fold: true,
      category: kind === "step" ? "stepMarkers" : "record",
      summary: kind === "step"
        ? { kind, noun: "step marker", plural: "step markers" }
        : { kind, noun: "completion", plural: "completions" },
    };
  };

  function WorkRow(input: { run: WorkRun }): Element {
    const records = () => resolve(input.run.partIDs);
    const thoughts = () => resolve(input.run.thinkingIDs);
    const toolsFor = () =>
      records().flatMap((part) =>
        part.kind === "tool"
          ? [tools.presentation(part.call, { directory: props.directory })]
          : []
      );
    const preview = createMemo(() => {
      const tools = toolsFor();
      if (tools.length) {
        const command = tools.length === 1 ? tools[0].copy?.command : undefined;
        return {
          text: command ??
            tools.map((tool) => tool.target).filter(Boolean).join(", "),
          mono: !!command,
        };
      }
      const facts = records().flatMap((part) => {
        const activity = parts.presentation(part, props.prefs).activity;
        return [activity?.state?.label, activity?.detail].filter(Boolean);
      });
      return { text: metaList(facts), mono: false };
    });
    const duration = () => {
      const end = input.run.live ? now() : input.run.end;
      return input.run.start === undefined || end === undefined
        ? undefined
        : elapsed(Math.max(0, end - input.run.start));
    };
    const trail = () => (
      <ChromeMeta class="otk-work-run-fact">
        <Show when={input.run.live}>
          <ActivityIndicator small label="Running" />
          {" Running - "}
        </Show>
        <Show
          when={toolsFor().length === 1 && toolsFor()[0].changes}
          fallback={
            <Show
              when={duration()}
              fallback={<TimeValue value={unknownTime()} />}
            >
              {(time) => <TimeText time={time()} />}
            </Show>
          }
        >
          {(changes) => (
            <>
              <span class="otk-work-add">+{changes().additions}</span>{" "}
              <span class="otk-work-del">−{changes().deletions}</span>
            </>
          )}
        </Show>
      </ChromeMeta>
    );
    const detail = () => (
      <div class="otk-work-run-detail">
        <div class="otk-work-run-preview">
          <ChromeMeta
            class={preview().mono ? "otk-work-command" : undefined}
            truncate
            title={preview().text}
          >
            {preview().text}
          </ChromeMeta>
          <Show when={input.run.child}>
            {(child) => (
              <ActionButton
                action={props.childAction(child())}
                class="otk-work-child otk-control-label"
                title="Open session"
                onFeedback={props.onFeedback}
              >
                Open session
              </ActionButton>
            )}
          </Show>
        </div>
        <WorkTimeBar
          run={input.run}
          start={axis().start}
          end={axis().end}
          now={now()}
        />
      </div>
    );
    const selected = () => props.selected === input.run.key;
    let row: HTMLDivElement | undefined;
    createEffect(selected, (active) => {
      if (active) row?.scrollIntoView({ block: "nearest" });
    });
    return (
      <div
        ref={row}
        class={[
          selection({
            kind: "candidate",
            selected: selected(),
            class: "otk-work-run",
          }).class,
          { "is-failed": input.run.failed, "is-running": input.run.live },
        ]}
        role="listitem"
        data-work-run={input.run.key}
      >
        <Show
          when={input.run.partIDs.length > 1}
          fallback={partView(records(), {
            get label() {
              return input.run.label;
            },
            get tone() {
              return input.run.failed ? "danger" : undefined;
            },
            required: () => input.run.failed,
            trail,
            detail,
            get extra() {
              return thoughts().length ? () => partView(thoughts()) : undefined;
            },
          })}
        >
          <Disclosure
            kind="activity"
            variant="label"
            label={input.run.label}
            identity={identify({ owner: input.run.key })}
            input={{ category: "work", required: () => input.run.failed }}
            tone={input.run.failed ? "danger" : undefined}
            lead={toolsFor()[0]?.icon ?? WorkLogIcon}
            hasContent={() => true}
            layout={({ trigger, region, open, frame }) => (
              <TreeNode
                ref={frame}
                trigger={{ variant: "span", element: trigger }}
                bodyVisible={open()}
                trail={trail}
                detail={detail}
                region={region}
              />
            )}
          >
            {() => partView([...records(), ...thoughts()])}
          </Disclosure>
        </Show>
      </div>
    );
  }

  return (
    <ScrollRegion
      axis="y"
      frameClass="otk-work-list-frame"
      class="otk-work-list"
    >
      <div role="list" aria-label="Work runs">
        <For each={props.work.runs} keyed={(run) => run.key}>
          {(run) => <WorkRow run={run()} />}
        </For>
      </div>
      <Show when={props.work.bookkeeping.length}>
        <RecordKinds
          items={props.work.bookkeeping}
          activity={bookkeeping}
          identity={props.reply.key}
          prefs={props.prefs}
          render={(visible, meta) => (
            <div class="otk-work-recorded">
              <div class="otk-work-recorded-meta">
                <ChromeMeta>Also recorded</ChromeMeta>
                {meta()}
              </div>
              <RecordedParts>{partView(visible())}</RecordedParts>
            </div>
          )}
        />
      </Show>
    </ScrollRegion>
  );
}

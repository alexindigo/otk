// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ActionControl,
  countLabel,
  messagePresentation,
  messageTimeValue,
  sessionKey,
  sessionResult,
  type TranscriptReply,
} from "@otk/client";
import { createMemo, type Element, Show } from "solid-js";
import { useCommandPorts } from "../keyboard/context.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import { useShellPorts } from "../shell/context.tsx";
import {
  ContentIdentityProvider,
  TranscriptRecords,
} from "../features/transcript-context.tsx";
import { ChevronIcon } from "./ChromeIcons.tsx";
import ActionButton from "./ActionButton.tsx";
import ChromeMeta, { MetaItem, MetaRow } from "./ChromeMeta.tsx";
import Clock from "./Clock.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import PaneState from "./PaneState.tsx";
import TimeValue from "./TimeValue.tsx";
import WorkRunList from "./WorkRunList.tsx";
import type { WorkRuns } from "./work-log.ts";
import "./WorkPanelView.css" with { type: "text" };

type Report = NonNullable<Parameters<typeof ActionButton>[0]["onFeedback"]>;

function WorkTurnHeader(props: {
  title: string;
  work: WorkRuns;
  time: ReturnType<typeof messageTimeValue>;
  at?: number;
  previous: ActionControl;
  next: ActionControl;
  reply: ActionControl;
  onFeedback: Report;
}): Element {
  const step = (action: ActionControl, left: boolean, label: string) => (
    <ActionButton
      action={action}
      class="otk-icon-button otk-work-step"
      title={label}
      label={label}
      onFeedback={props.onFeedback}
    >
      <ControlIcon>
        <ChevronIcon left={left} />
      </ControlIcon>
    </ActionButton>
  );
  return (
    <header class="otk-work-turn">
      {step(props.previous, true, "Previous reply")}
      <ActionButton
        action={props.reply}
        class="otk-work-turn-identity"
        label="Show reply"
        title="Show reply"
        onFeedback={props.onFeedback}
      >
        <span class="otk-work-turn-title otk-control-label" title={props.title}>
          {props.title}
        </span>
        <MetaRow>
          <MetaItem rank={1} required>
            <ChromeMeta>
              {countLabel(props.work.actions, "action")}
              <Show when={props.work.failed.length}>
                <span class="otk-work-failed">
                  {`, ${props.work.failed.length} failed`}
                </span>
              </Show>
            </ChromeMeta>
          </MetaItem>
          <MetaItem rank={2}>
            <ChromeMeta>
              <TimeValue value={props.time} />
            </ChromeMeta>
          </MetaItem>
          <Show when={props.at !== undefined}>
            <MetaItem rank={3}>
              <Clock at={props.at!} />
            </MetaItem>
          </Show>
        </MetaRow>
      </ActionButton>
      {step(props.next, false, "Next reply")}
    </header>
  );
}

export default function WorkPanelView(): Element {
  const shell = useShellPorts();
  const { parts } = useUiRegistries();
  const { commands } = useCommandPorts();
  const session = () => shell.selection();
  const prefs = () => shell.toggles.state.prefs;
  const records = () => shell.transcript.records?.();
  const model = () => session() && shell.work.model(session()!);
  const turns = createMemo(() => model()?.turns() ?? []);
  const shown = createMemo(() => {
    const selected = session();
    if (!selected) return;
    const latest = turns().at(-1);
    return shell.work.panel.shown(
      sessionKey(selected.sidecarId, selected.sessionID),
      turns(),
      latest ? model()?.runs(latest)?.live?.key : undefined,
    );
  });
  const reply = () => {
    const turn = shown()?.turn;
    return turn ? records()?.state.repliesByID[turn] : undefined;
  };
  const work = () => {
    const turn = shown()?.turn;
    return turn ? model()?.runs(turn) : undefined;
  };
  const entry = () => {
    const selected = session();
    return selected && shell.entry(selected.sidecarId, selected.sessionID);
  };
  const clock = () => {
    const outcome = display()?.time?.outcome;
    return outcome?.state === "known" ? outcome.at : undefined;
  };
  const display = createMemo(() => {
    const message = reply()?.message;
    return message &&
      messagePresentation(message, sessionResult(entry(), message));
  });
  const title = (value: TranscriptReply) => {
    const message = value.message;
    const prompt = message.role === "assistant" && message.replyTo
      ? records()?.state.messagesByID[message.replyTo]
      : undefined;
    for (const part of prompt?.parts ?? []) {
      const text = parts.presentation(part, prefs()).text?.trim();
      if (text) return text.split(/\r?\n/, 1)[0];
    }
    return "Reply";
  };
  const run = (id: string, args?: unknown) =>
    void commands.run(id, args).catch((cause) => shell.reportFailure?.(cause));
  const target = () => ({ ...session(), label: entry()?.title });
  const child = (sessionID: string) =>
    commands.control("session.child", sessionID, {
      target: { ...target(), sessionID },
      shown: () => session()?.sessionID === sessionID,
      unshown: "The child session was not opened.",
      recovery: "Try opening the session again.",
    });
  const step = (delta: -1 | 1, label: string): ActionControl => {
    const destination = delta < 0 ? shown()?.previous : shown()?.next;
    const action = commands.control("work.step", { delta }, {
      target: target(),
      active: () => destination !== undefined,
      shown: () => shown()?.turn === destination,
      unshown: "No reply was shown.",
      recovery: "Try selecting the reply again.",
    });
    return destination ? action : {
      ...action,
      availability: () => ({ available: false, reason: label }),
    };
  };
  const onFeedback: Report = (outcome) =>
    shell.reportFailure?.(outcome.feedback);
  return (
    <div class="otk-work-panel">
      <Show
        when={reply() && work() && records()}
        fallback={
          <PaneState>
            {session()
              ? "No work in this session yet."
              : "Choose a session to view its Work log."}
          </PaneState>
        }
      >
        {(owner) => (
          <>
            <WorkTurnHeader
              title={title(reply()!)}
              work={work()!}
              time={messageTimeValue(display()?.time)}
              at={clock()}
              previous={step(-1, "Previous reply")}
              next={step(1, "Next reply")}
              reply={commands.control("work.reply", undefined, {
                target: target(),
                shown: () => true,
                unshown: "The conversation did not reveal the reply.",
                recovery: "Try showing the reply again.",
              })}
              onFeedback={onFeedback}
            />
            <Show when={JSON.stringify([session(), shown()?.turn])} keyed>
              {(_key) => (
                <TranscriptRecords
                  interaction={owner().interaction}
                  placement="workPanel"
                  nativeSource={owner().nativeSource}
                >
                  <ContentIdentityProvider
                    value={{
                      ...session(),
                      ownerID: reply()!.key,
                      messageID: reply()!.firstID,
                      directory: entry()?.directory,
                    }}
                  >
                    <WorkRunList
                      work={work()!}
                      reply={reply()!}
                      selected={shown()?.run}
                      prefs={prefs()}
                      directory={entry()?.directory}
                      permissions={owner().state.content.permissions}
                      streaming={!!display()?.streaming}
                      onOpenChild={(id) => run("session.child", id)}
                      childAction={child}
                      onFeedback={onFeedback}
                    />
                  </ContentIdentityProvider>
                </TranscriptRecords>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

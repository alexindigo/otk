// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import type { TranscriptReply } from "@otk/client";
import type { PartPresentation } from "../registries/renderers.ts";
import {
  partFrames,
  type PartGroup,
  partGroups,
  type ReplyStart,
} from "./work-log.ts";

export interface MessageLayout {
  frames: { id: string; transcript: boolean; groups: PartGroup[] }[];
  userBubble: boolean;
  prompt: boolean;
  copyable: boolean;
  replyAgents: ReplyStart[];
}
interface Descriptor {
  part: Part;
  messageID: string;
  value: PartPresentation;
  copyable: boolean;
}
/** Presentation indexes borrow source segments; ordinary replacements never
 * flatten a grouped reply or re-run historical feature presenters. */
export function createMessageLayout() {
  let state: MessageLayout = {
    frames: [],
    userBubble: false,
    prompt: false,
    copyable: false,
    replyAgents: [],
  };
  let preference: string | undefined, previousRole = "", copyable = 0;
  let order: string[] = [];
  const segments = new Map<
    string,
    {
      parts: Part[];
      rows: Descriptor[];
      agent?: string;
      model?: ReplyStart["model"];
      time?: ReplyStart["time"];
      turnID?: string;
    }
  >();
  const parts = new Map<string, Descriptor>();
  const slots = new Map<
    string,
    { frame: number; group: number; index: number }
  >();
  return {
    source: (id: string) => parts.get(id)?.messageID,
    update(
      id: string,
      role: string,
      input: readonly TranscriptReply["segments"][number][],
      version: string,
      present: (part: Part) => PartPresentation,
    ): MessageLayout {
      const changedPreferences = preference !== version;
      let structural = role !== previousRole || order.length !== input.length ||
        input.some((segment, i) => segment.messageID !== order[i]);
      const replacements: { before: Descriptor; after: Descriptor }[] = [];
      const changedSources = new Set<string>();
      for (const segment of input) {
        const old = segments.get(segment.messageID);
        if (
          old?.agent !== segment.agent || old?.time !== segment.time ||
          old?.model !== segment.model || old?.turnID !== segment.turnID
        ) {
          changedSources.add(segment.messageID);
          if (
            !!(old?.agent !== undefined && old.time) !==
              !!(segment.agent !== undefined && segment.time)
          ) structural = true;
          if (old) {
            segments.set(segment.messageID, {
              ...old,
              agent: segment.agent,
              model: segment.model,
              time: segment.time,
              turnID: segment.turnID,
            });
          }
        }
        if (!changedPreferences && old?.parts === segment.parts) continue;
        const rows = segment.parts.map((part) => {
          const before = parts.get(part.id);
          if (
            !changedPreferences && before?.part === part &&
            before.messageID === segment.messageID
          ) return before;
          const value = present(part);
          const after = {
            part,
            messageID: segment.messageID,
            value,
            copyable: value.copyable ?? !!value.text,
          };
          if (
            !before || !!before.value.hidden !== !!value.hidden ||
            before.value.frame !== value.frame ||
            !!before.value.prose !== !!value.prose ||
            !!before.value.work !== !!value.work ||
            !!before.value.required !== !!value.required
          ) structural = true;
          if (before) replacements.push({ before, after });
          parts.set(part.id, after);
          return after;
        });
        if (
          !old || old.rows.length !== rows.length ||
          rows.some((row, i) => row.part.id !== old.rows[i].part.id)
        ) structural = true;
        segments.set(segment.messageID, {
          parts: segment.parts,
          rows,
          agent: segment.agent,
          model: segment.model,
          time: segment.time,
          turnID: segment.turnID,
        });
      }
      preference = version;
      previousRole = role;
      // Calls are source identities, not footer fact identities. Preserve the
      // first occurrence of each agent, including tool-only model calls.
      const replyAgents = structural || changedSources.size
        ? (() => {
          const agents = new Map<string, ReplyStart>();
          if (role === "assistant") {
            for (const { agent, messageID, turnID, model, time } of input) {
              if (agent === undefined || !time || agents.has(agent)) continue;
              agents.set(agent, {
                agent,
                messageID,
                turnID,
                model,
                time,
                continuation: agents.size > 0,
              });
            }
          }
          return [...agents.values()];
        })()
        : state.replyAgents;
      if (structural) {
        const rows = input.flatMap((segment) =>
          segments.get(segment.messageID)!.rows
        );
        const retained = new Set(rows.map((row) => row.part.id));
        for (const key of parts.keys()) {
          if (!retained.has(key)) parts.delete(key);
        }
        const members = new Set(input.map((segment) => segment.messageID));
        for (const key of segments.keys()) {
          if (!members.has(key)) segments.delete(key);
        }
        copyable = rows.reduce((count, row) => count + Number(row.copyable), 0);
        const frames = partFrames(
          rows.map((row) => row.part),
          (part) => parts.get(part.id)!.value,
          role === "assistant",
        );
        if (!frames.length && role === "assistant") {
          frames.push({ id, parts: [], transcript: false });
        }
        const usedGroups = new Set<string>(), usedFrames = new Set<string>();
        const next = frames.map((frame) => {
          const groups = partGroups(
            frame.parts,
            (part) => role === "assistant" ? parts.get(part.id)!.value : {},
          );
          // Prepending source keeps already-measured prose identities.
          for (const group of groups) {
            const known = group.parts.map((part) => slots.get(part.id)).find((
              slot,
            ) =>
              slot &&
              !usedGroups.has(state.frames[slot.frame].groups[slot.group].id)
            );
            if (known) {
              const previous = state.frames[known.frame].groups[known.group];
              group.id = previous.id;
            }
            if (usedGroups.has(group.id)) group.id = `group:${group.id}`;
            usedGroups.add(group.id);
          }
          const known = groups.flatMap((group) => group.parts).map((part) =>
            slots.get(part.id)
          ).find((slot) =>
            slot && !usedFrames.has(state.frames[slot.frame].id)
          );
          let key = known ? state.frames[known.frame].id : frame.id;
          if (usedFrames.has(key)) key = `frame:${key}`;
          usedFrames.add(key);
          return { id: key, transcript: frame.transcript, groups };
        });
        slots.clear();
        next.forEach((frame, f) =>
          frame.groups.forEach((group, g) => {
            group.parts.forEach((part, index) =>
              slots.set(part.id, { frame: f, group: g, index })
            );
          })
        );
        order = input.map((segment) => segment.messageID);
        const userBubble = role === "user" &&
          next.some((frame) => !frame.transcript);
        state = {
          frames: next,
          userBubble,
          prompt: role === "user" && userBubble,
          copyable: copyable > 0,
          replyAgents,
        };
        return state;
      }
      let frames = state.frames;
      const changedFrames = new Set<number>(),
        changedGroups = new Set<string>();
      const writable = (f: number, g: number) => {
        if (frames === state.frames) frames = [...frames];
        if (!changedFrames.has(f)) {
          frames[f] = { ...frames[f], groups: [...frames[f].groups] };
          changedFrames.add(f);
        }
        const key = `${f}:${g}`;
        if (!changedGroups.has(key)) {
          const group = frames[f].groups[g];
          frames[f].groups[g] = { ...group, parts: [...group.parts] };
          changedGroups.add(key);
        }
        return frames[f].groups[g];
      };
      for (const { before, after } of replacements) {
        copyable += Number(after.copyable) - Number(before.copyable);
        const slot = slots.get(after.part.id);
        if (
          !slot ||
          before.part === after.part &&
            before.value.timing === after.value.timing
        ) continue;
        writable(slot.frame, slot.group).parts[slot.index] = after.part;
      }
      if (
        frames !== state.frames || replyAgents !== state.replyAgents ||
        state.copyable !== (copyable > 0)
      ) {
        state = { ...state, frames, replyAgents, copyable: copyable > 0 };
      }
      return state;
    },
  };
}

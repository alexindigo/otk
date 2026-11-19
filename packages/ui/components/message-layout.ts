// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import type { TranscriptReply } from "@otk/client";
import type { PartPresentation } from "../registries/renderers.ts";
import {
  partFrames,
  type PartGroup,
  partGroups,
  type ReplyStart,
  segmentWorkingTime,
} from "./work-log.ts";

export interface MessageLayout {
  frames: { id: string; transcript: boolean; groups: PartGroup[] }[];
  userBubble: boolean;
  prompt: boolean;
  copyable: boolean;
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
  };
  let preference: string | undefined, previousRole = "", copyable = 0;
  let order: string[] = [];
  let waits: Part[] = [];
  const segments = new Map<
    string,
    {
      parts: Part[];
      rows: Descriptor[];
      agent?: string;
      time?: ReplyStart["time"];
    }
  >();
  const parts = new Map<string, Descriptor>();
  const sourceSlots = new Map<string, { frame: number; group: number }>();
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
        if (old?.agent !== segment.agent || old?.time !== segment.time) {
          changedSources.add(segment.messageID);
          if (
            !!(old?.agent !== undefined && old.time) !==
              !!(segment.agent !== undefined && segment.time)
          ) structural = true;
          if (old) {
            segments.set(segment.messageID, {
              ...old,
              agent: segment.agent,
              time: segment.time,
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
          time: segment.time,
        });
      }
      preference = version;
      previousRole = role;
      const waitsChanged = replacements.some(({ before, after }) =>
        before.value.timing?.waitsForUser || after.value.timing?.waitsForUser
      );
      if (structural) {
        const rows = input.flatMap((segment) =>
          segments.get(segment.messageID)!.rows
        );
        const retained = new Set(rows.map((row) => row.part.id));
        waits = rows.filter((row) => row.value.timing?.waitsForUser).map((
          row,
        ) => row.part);
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
        const proseSources = new Set<string>();
        const next = frames.map((frame) => {
          const groups = partGroups(
            frame.parts,
            (part) => role === "assistant" ? parts.get(part.id)!.value : {},
            waits,
            (part) => {
              if (role !== "assistant") return;
              const messageID = parts.get(part.id)!.messageID;
              const source = segments.get(messageID)!;
              if (
                source.agent === undefined || !source.time ||
                proseSources.has(messageID)
              ) return;
              const continuation = proseSources.size > 0;
              proseSources.add(messageID);
              return {
                messageID,
                agent: source.agent,
                time: source.time,
                continuation,
              };
            },
          );
          // Prepending a work prefix keeps an already-known fold's identity.
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
        sourceSlots.clear();
        next.forEach((frame, f) =>
          frame.groups.forEach((group, g) => {
            if (group.replyStart) {
              sourceSlots.set(group.replyStart.messageID, {
                frame: f,
                group: g,
              });
            }
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
        };
        return state;
      }
      if (waitsChanged) {
        waits = [...parts.values()].filter((row) =>
          row.value.timing?.waitsForUser
        ).map((row) => row.part);
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
      for (const id of changedSources) {
        const slot = sourceSlots.get(id), source = segments.get(id);
        if (!slot || source?.agent === undefined || !source.time) continue;
        const group = writable(slot.frame, slot.group);
        group.replyStart = {
          ...group.replyStart!,
          agent: source.agent,
          time: source.time,
        };
      }
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
      for (const key of changedGroups) {
        const [f, g] = key.split(":").map(Number);
        const group = frames[f].groups[g];
        if (group.work) {
          group.workingMs = segmentWorkingTime(
            group.parts,
            (part) => parts.get(part.id)!.value,
            waits,
          );
        }
      }
      if (waitsChanged) {
        for (let f = 0; f < frames.length; f++) {
          for (let g = 0; g < frames[f].groups.length; g++) {
            const group = frames[f].groups[g];
            if (!group.work || changedGroups.has(`${f}:${g}`)) continue;
            const workingMs = segmentWorkingTime(
              group.parts,
              (part) => parts.get(part.id)!.value,
              waits,
            );
            if (workingMs !== group.workingMs) {
              writable(f, g).workingMs = workingMs;
            }
          }
        }
      }
      if (frames !== state.frames || state.copyable !== (copyable > 0)) {
        state = { ...state, frames, copyable: copyable > 0 };
      }
      return state;
    },
  };
}

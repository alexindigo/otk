// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import type { PartPresentation } from "../registries/renderers.ts";
import { partFrames, type PartGroup, partGroups } from "./work-log.ts";

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
  const segments = new Map<string, { parts: Part[]; rows: Descriptor[] }>();
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
      input: readonly { messageID: string; parts: Part[] }[],
      version: string,
      present: (part: Part) => PartPresentation,
    ): MessageLayout {
      const changedPreferences = preference !== version;
      let structural = role !== previousRole || order.length !== input.length ||
        input.some((segment, i) => segment.messageID !== order[i]);
      const replacements: { before: Descriptor; after: Descriptor }[] = [];
      for (const segment of input) {
        const old = segments.get(segment.messageID);
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
        segments.set(segment.messageID, { parts: segment.parts, rows });
      }
      preference = version;
      previousRole = role;
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
        next.forEach((frame, f) =>
          frame.groups.forEach((group, g) =>
            group.parts.forEach((part, index) =>
              slots.set(part.id, { frame: f, group: g, index })
            )
          )
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
      let frames = state.frames;
      const changedFrames = new Set<number>(),
        changedGroups = new Set<string>();
      for (const { before, after } of replacements) {
        copyable += Number(after.copyable) - Number(before.copyable);
        const slot = slots.get(after.part.id);
        if (!slot || before.part === after.part) continue;
        if (frames === state.frames) frames = [...frames];
        if (!changedFrames.has(slot.frame)) {
          frames[slot.frame] = {
            ...frames[slot.frame],
            groups: [...frames[slot.frame].groups],
          };
          changedFrames.add(slot.frame);
        }
        const key = `${slot.frame}:${slot.group}`, frame = frames[slot.frame];
        if (!changedGroups.has(key)) {
          const group = frame.groups[slot.group];
          frame.groups[slot.group] = { ...group, parts: [...group.parts] };
          changedGroups.add(key);
        }
        frame.groups[slot.group].parts[slot.index] = after.part;
      }
      if (frames !== state.frames || state.copyable !== (copyable > 0)) {
        state = { ...state, frames, copyable: copyable > 0 };
      }
      return state;
    },
  };
}

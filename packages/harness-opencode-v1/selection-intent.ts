// SPDX-License-Identifier: LGPL-3.0-only
import type { Info, RawPart } from "./types.ts";

/** Live native facts only. Historical mapping has no access to this owner. */
export class SelectionIntents {
  #users = new Map<
    string,
    { id: string; agent: string; time: number; approved: boolean }
  >();
  header(info: Info): void {
    if (info.role !== "user") return;
    const previous = this.#users.get(info.sessionID);
    if (previous?.id === info.id && previous.agent === info.agent) return;
    if (previous && previous.time > info.time.created) return;
    if (!info.agent) return this.release(info.sessionID);
    this.#users.set(info.sessionID, {
      id: info.id,
      agent: info.agent,
      time: info.time.created,
      approved: false,
    });
  }
  part(part: RawPart): { agent: string } | undefined {
    const user = this.#users.get(part.sessionID);
    if (!user) return;
    // Stock plan.ts emits an agent-bearing user record followed by this synthetic
    // approval part before completing its tool. The agent comes from that record,
    // never a name-to-agent table or an external plugin's coincidental tool name.
    if (
      part.messageID === user.id && part.type === "text" && part.synthetic &&
      /^The plan at [^\n]+ has been approved, you can now edit files\. Execute the plan$/
        .test(part.text ?? "")
    ) {
      user.approved = true;
    }
    const state = part.state;
    if (
      part.type !== "tool" || state?.status !== "completed" || !user.approved ||
      state.time?.end === undefined || !Number.isFinite(state.time.start) ||
      !Number.isFinite(state.time.end) || state.time.start > user.time ||
      state.time.end < user.time ||
      state.title !== `Switching to ${user.agent} agent` ||
      state.output !==
        `User approved switching to ${user.agent} agent. Wait for further instructions.`
    ) return;
    return { agent: user.agent };
  }
  release(sessionID: string): void {
    this.#users.delete(sessionID);
  }
  clear(): void {
    this.#users.clear();
  }
}

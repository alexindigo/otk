// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";
import { stopUnit } from "./protocol.ts";

const exec = promisify(execFile);
/** The CDP default context cannot enable Playwright's context-creation video
 * option. Record genuine Chromium screencast frames, preserving their cadence.
 * This observes pixels only; all interaction still belongs to Playwright.
 */
export async function notificationVideo(
  page: Page,
  root: string,
  info: TestInfo,
  name: string,
) {
  const directory = join(root, `frames-${randomUUID()}`);
  await mkdir(directory);
  const session = await page.context().newCDPSession(page);
  const frames: { name: string; time: number }[] = [];
  const errors: unknown[] = [];
  let writes = Promise.resolve();
  session.on("Page.screencastFrame", (event) => {
    const name = `frame-${frames.length}.jpeg`;
    frames.push({ name, time: event.metadata.timestamp ?? 0 });
    writes = writes.then(() =>
      writeFile(join(directory, name), Buffer.from(event.data, "base64"))
    );
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch((error) => {
        if (!page.isClosed()) errors.push(error);
      });
  });
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  return async () => {
    if (!page.isClosed()) await session.send("Page.stopScreencast");
    await writes;
    if (errors.length) {
      throw new AggregateError(errors, "Notification screencast failed");
    }
    if (info.status === info.expectedStatus) {
      await rm(directory, { recursive: true });
      return;
    }
    if (!frames.length) {
      throw new Error("Missing first-failure notification video frames");
    }
    const concat = ["ffconcat version 1.0"];
    frames.forEach((frame, n) => {
      concat.push(
        `file '${frame.name}'`,
        `duration ${
          Math.max(.001, (frames[n + 1]?.time ?? frame.time + .1) - frame.time)
        }`,
      );
    });
    concat.push(`file '${frames.at(-1)!.name}'`);
    await writeFile(
      join(directory, "frames.ffconcat"),
      concat.join("\n") + "\n",
    );
    await writeFile(join(directory, "frames.json"), JSON.stringify(frames));
    const unit =
      `${process.env.OTK_TEST_RUN}-notification-video-${randomUUID()}.service`;
    const owned = join(root, `video-${randomUUID()}`);
    await mkdir(owned);
    await appendFile(
      process.env.OTK_TEST_UNIT_INVENTORY!,
      JSON.stringify({ unit, root: owned }) + "\n",
    );
    await writeFile(
      join(owned, "owned.json"),
      JSON.stringify({ pids: [], ports: [] }),
    );
    const path = info.outputPath(`${name}.webm`);
    try {
      await exec("systemd-run", [
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        `--unit=${unit}`,
        "--property=KillMode=control-group",
        `--setenv=TMPDIR=${process.env.TMPDIR}`,
        "/usr/bin/ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(directory, "frames.ffconcat"),
        "-fps_mode",
        "vfr",
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-y",
        path,
      ], { timeout: 30_000 });
      await info.attach(name, { path, contentType: "video/webm" });
    } finally {
      await stopUnit(unit);
    }
  };
}

// SPDX-License-Identifier: LGPL-3.0-only
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserContext,
  chromium,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { isolatedTest } from "./isolated.ts";
import { expect } from "./evidence.ts";
import { stopUnit } from "./protocol.ts";
import { notificationVideo } from "./notification-video.ts";

const exec = promisify(execFile);
interface NativeNotifications {
  context(): Promise<BrowserContext>;
  open(context?: BrowserContext): Promise<Page>;
}

/** Approved notification-only default contexts bypass Playwright's forced focus.
 * See Playwright coreBundle.js:39020-39024, public connectOverCDP.noDefaults.
 * Native Chromium and all its children are independently supervised guest units.
 */
export const notificationTest = isolatedTest.extend<
  { notificationPages: NativeNotifications }
>({
  notificationPages: async ({ browserName: _browserName }, use, info) => {
    const owners: {
      context: BrowserContext;
      open(): Promise<Page>;
      close(): Promise<void>;
    }[] = [];
    const context = async () => {
      const owner = await nativeContext(info, owners.length);
      owners.push(owner);
      return owner.context;
    };
    const errors: unknown[] = [];
    try {
      await use({
        context,
        open: async (existing) => {
          const target = existing ?? await context();
          const owner = owners.find((owner) => owner.context === target);
          if (!owner) throw new Error("Foreign notification context");
          return await owner.open();
        },
      });
    } catch (error) {
      errors.push(error);
    }
    for (const owner of owners.reverse()) {
      try {
        await owner.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Notification browser lifetime failed");
    }
  },
  context: async ({ notificationPages }, use) => {
    await use(await notificationPages.context());
  },
  page: async ({ context, notificationPages }, use) => {
    const page = await notificationPages.open(context);
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});

async function nativeContext(info: TestInfo, index: number) {
  const run = process.env.OTK_TEST_RUN!,
    runRoot = process.env.OTK_TEST_RUN_ROOT!;
  const root = join(runRoot, `notification-browser-${randomUUID()}`);
  const unit = `${run}-notification-browser-${randomUUID()}.service`;
  const binary = chromium.executablePath();
  if (
    !process.env.PLAYWRIGHT_BROWSERS_PATH ||
    !binary.startsWith(process.env.PLAYWRIGHT_BROWSERS_PATH + "/")
  ) {
    throw new Error(
      "Notification browser must use the pinned managed Chromium",
    );
  }
  await mkdir(join(root, "profile"), { recursive: true });
  await appendFile(
    process.env.OTK_TEST_UNIT_INVENTORY!,
    JSON.stringify({ unit, root }) + "\n",
  );
  const env = Object.entries(process.env).filter(([key, value]) =>
    value !== undefined &&
    (key.startsWith("OTK_TEST_") ||
      ["PATH", "TMPDIR", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
        .includes(key))
  ).map(([key, value]) => `--setenv=${key}=${value}`);
  const child = spawn("systemd-run", [
    "--user",
    "--pipe",
    "--wait",
    "--quiet",
    `--unit=${unit}`,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=10s",
    ...env,
    "--setenv=TZ=UTC",
    binary,
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1280,800",
    "--lang=en-US",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "profile")}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  let log = "", context: BrowserContext | undefined;
  child.stdout.on("data", (data) => {
    log += data.toString();
  });
  child.stderr.on("data", (data) => {
    log += data.toString();
  });
  let pids: number[] = [], port: number | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const recordings: Promise<() => Promise<void>>[] = [];
  const close = async () => {
    const errors: unknown[] = [];
    try {
      if (context) {
        if (info.status !== info.expectedStatus) {
          for (const [n, page] of context.pages().entries()) {
            if (page.isClosed()) continue;
            const path = info.outputPath(`notification-${index}-${n}.png`);
            await page.screenshot({ path, fullPage: true });
            await info.attach(`notification-${index}-${n}`, {
              path,
              contentType: "image/png",
            });
          }
        }
      }
    } catch (error) {
      errors.push(error);
    }
    for (const recording of recordings) {
      try {
        await (await recording)();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await browser?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await stopUnit(unit);
      await exited;
    } catch (error) {
      errors.push(error);
    }
    try {
      await expect.poll(async () => {
        const { stdout } = await exec("systemctl", [
          "--user",
          "show",
          unit,
          "--property=ControlGroup",
          "--value",
        ], { timeout: 5000 });
        const group = stdout.trim();
        if (!group) return true;
        try {
          await access(join("/sys/fs/cgroup", group));
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
      }).toBe(true);
      for (const pid of pids) {
        await expect.poll(async () => {
          try {
            await access(`/proc/${pid}`);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
          }
        }).toBe(true);
      }
    } catch (error) {
      errors.push(error);
    }
    await writeFile(join(root, "browser.log"), log);
    await writeFile(
      join(root, "cleanup.json"),
      JSON.stringify({ unit, pids, port, errors: errors.map(String) }, null, 2),
    );
    await info.attach(`notification-browser-${index}-ownership`, {
      body: JSON.stringify({
        unit,
        root,
        pids,
        port,
        errors: errors.map(String),
      }),
      contentType: "application/json",
    });
    if (errors.length) {
      throw new AggregateError(
        errors,
        "Native notification context teardown failed",
      );
    }
  };
  try {
    let endpoint = "";
    await expect.poll(async () => {
      try {
        const lines =
          (await readFile(join(root, "profile/DevToolsActivePort"), "utf8"))
            .trim().split("\n");
        port = Number(lines[0]);
        endpoint = `ws://127.0.0.1:${port}${lines[1]}`;
        return Number.isInteger(port) && port > 0 &&
          lines[1]?.startsWith("/devtools/browser/");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, { timeout: 30_000 }).toBe(true);
    const { stdout } = await exec("systemctl", [
      "--user",
      "show",
      unit,
      "--property=ControlGroup",
      "--value",
    ], { timeout: 5000 });
    pids = (await readFile(
      join("/sys/fs/cgroup", stdout.trim(), "cgroup.procs"),
      "utf8",
    )).trim().split("\n").filter(Boolean).map(Number);
    await writeFile(
      join(root, "owned.json"),
      JSON.stringify({ pids, ports: [port] }),
    );
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    context = browser.contexts()[0];
    context.setDefaultTimeout(10_000);
    // Playwright Test's instrumentation owns tracing for attached contexts too.
    for (const page of context.pages()) await page.close();
    return {
      context,
      close,
      async open() {
        const page = await context!.newPage();
        await page.setViewportSize({ width: 1280, height: 800 });
        // Own recordings before handing a content page to a test. Native blank
        // cover targets are presentation resources, never recording consumers.
        const recording = notificationVideo(
          page,
          root,
          info,
          `notification-${index}-${recordings.length}-video`,
        );
        recordings.push(recording);
        await recording;
        return page;
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Notification browser startup and cleanup failed",
      );
    }
    throw error;
  }
}

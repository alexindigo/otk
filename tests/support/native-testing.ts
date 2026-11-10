// SPDX-License-Identifier: LGPL-3.0-only
/** Native selection for non-browser consumers; protocol shapes stay at this seam. */
import type { Harness } from "@otk/harness";
import {
  OpencodeV1Adapter,
  opencodeV1ReadCodecs,
} from "@otk/harness-opencode-v1";
import {
  opencodeV2ReadCodecs,
  OpencodeV2ServerAdapter,
} from "@otk/harness-opencode-v2-server";
import type { DigestBridgeOptions } from "../../core/digest/bridge.ts";
import { cfg } from "./config.ts";
import { FakeLlm } from "./fake-llm.ts";
import { startNative } from "./native-fixture.ts";
import { OpencodeTest, waitFor } from "./opencode.ts";
import { OpencodeV2Test } from "./opencode-v2.ts";
import { acquire, resources } from "./resources.ts";
import { SidecarTest } from "./sidecar.ts";
import { nativeKind } from "./native.ts";
import { tempDir } from "./resources.ts";
import { join } from "@std/path";

export type TestNative = OpencodeTest | OpencodeV2Test;
export async function nativeDiscovery(
  native: TestNative,
  url = native.url,
): Promise<Record<string, string>> {
  if (native.kind === "opencode-v1") return {};
  if (url === native.url) return native.discoveryEnv;
  const root = await tempDir("native-transport-discovery-");
  await Deno.mkdir(join(root, "opencode"));
  const registration = JSON.parse(await Deno.readTextFile(native.serviceFile));
  await Deno.writeTextFile(
    join(root, "opencode/service.json"),
    JSON.stringify({ ...registration, url }),
    { mode: 0o600 },
  );
  return { ...native.discoveryEnv, XDG_STATE_HOME: root };
}
export async function useNativeDiscovery(
  native: TestNative,
  url = native.url,
): Promise<void> {
  for (
    const [key, value] of Object.entries(await nativeDiscovery(native, url))
  ) {
    const previous = Deno.env.get(key);
    Deno.env.set(key, value);
    resources().defer(
      `restore native discovery ${key}`,
      () =>
        previous === undefined
          ? Deno.env.delete(key)
          : Deno.env.set(key, previous),
    );
  }
}
export function selectedNative(fake = new FakeLlm(), options?: {
  prepare?(fixture: Pick<TestNative, "root" | "directory">): Promise<void>;
}): Promise<TestNative> {
  if (!options) return startNative(fake) as Promise<TestNative>;
  return nativeKind === "opencode-v2-server"
    ? OpencodeV2Test.start(fake, options)
    : OpencodeTest.start(fake, undefined, options);
}
export function nativeBehavior(options?: Parameters<typeof selectedNative>[1]) {
  return acquire("native behavior stack", async () => {
    const fake = new FakeLlm(), oc = await selectedNative(fake, options);
    const servers: SidecarTest[] = [];
    const stop = resources().defer("behavior peers", async () => {
      await Promise.all([...servers.map((server) => server.stop()), oc.stop()]);
      await fake.stop();
    });
    return {
      fake,
      oc,
      stop,
      servers,
      async sidecar(overrides: Parameters<typeof SidecarTest.start>[1] = {}) {
        const server = await SidecarTest.start(oc, overrides);
        servers.push(server);
        return server;
      },
    };
  });
}
export function nativeDigest(
  native: TestNative,
): Pick<DigestBridgeOptions, "provider" | "native" | "reads"> {
  const settings = cfg();
  return native.kind === "opencode-v2-server"
    ? {
      provider: native.kind,
      reads: opencodeV2ReadCodecs,
      native: {
        serviceFile: native.serviceFile,
        db: native.db,
        requestms: settings.harness.requestms,
        attachments: settings.attachments,
      },
    }
    : {
      provider: native.kind,
      reads: opencodeV1ReadCodecs,
      native: {
        ...settings,
        harness: { ...settings.harness, url: native.url, db: native.db },
      },
    };
}
export function nativeHarness(native: TestNative): Harness {
  const settings = cfg();
  return native.kind === "opencode-v2-server"
    ? new OpencodeV2ServerAdapter({
      serviceFile: native.serviceFile,
      harness: settings.harness,
      messages: settings.messages,
    })
    : new OpencodeV1Adapter({
      ...settings,
      harness: { ...settings.harness, url: native.url, db: native.db },
    });
}
export async function startHarness(harness: Harness): Promise<void> {
  await harness.core.start({
    connection() {},
    indexReset() {},
    indexUpsert() {},
    indexRemove() {},
    content() {},
    bootstrapComplete() {},
    invalidate() {},
  });
}
export async function nativePrompt(
  native: TestNative,
  id: string,
  text: string,
): Promise<void> {
  const previous = native.kind === "opencode-v1"
    ? new Set(
      (await native.request<{ info: { id: string } }[]>(
        `/session/${id}/message`,
      )).map((row) => row.info.id),
    )
    : undefined;
  await native.prompt(id, text);
  if (native.kind === "opencode-v2-server") {
    const { opencodeV2SessionID } = await import(
      "@otk/harness-opencode-v2-server"
    );
    await native.api.experimental.session.wait({
      sessionID: opencodeV2SessionID.decode(id),
    });
  } else {
    const { opencodeV1SessionID } = await import("@otk/harness-opencode-v1");
    await waitFor(
      () =>
        native.request<
          { info: { id: string; role: string; time: { completed?: number } } }[]
        >(`/session/${id}/message`),
      (rows) =>
        rows.some((row) =>
          !previous!.has(row.info.id) && row.info.role === "assistant" &&
          row.info.time.completed !== undefined
        ),
    );
    await waitFor(
      () => native.request<Record<string, unknown>>("/session/status"),
      (status) => !status[opencodeV1SessionID.decode(id)],
    );
  }
}

/** Admit a stopped historical transcript through the stock native API, not SQL. */
export async function seedUserSession(
  native: TestNative,
  title: string,
  texts: string[],
  files: { name: string; mime: string; dataBase64: string }[] = [],
): Promise<{ id: string; nativeID: string; messages: string[] }> {
  const session = await native.createSession(title);
  const messages: string[] = [];
  if (native.kind === "opencode-v1") {
    for (const text of texts) {
      const row = await native.request<{ info: { id: string } }>(
        `/session/${session.id}/message`,
        {
          method: "POST",
          body: {
            noReply: true,
            parts: [
              { type: "text", text },
              ...files.map((file) => ({
                type: "file",
                filename: file.name,
                mime: file.mime,
                url: `data:${file.mime};base64,${file.dataBase64}`,
              })),
            ],
          },
        },
      );
      messages.push(row.info.id);
    }
  } else {
    const info = await native.api.session.get({ sessionID: session.nativeID });
    await native.api.session.remove({ sessionID: session.nativeID });
    const clock = Date.now();
    const rows = texts.map((text, index) => {
      const id = `msg_fixture${crypto.randomUUID().replaceAll("-", "")}`;
      messages.push(id);
      return {
        id,
        type: "user",
        text,
        time: { created: clock + index },
        ...(files.length
          ? {
            files: files.map((file) => ({
              name: file.name,
              mime: file.mime,
              data: file.dataBase64,
              source: { type: "inline" },
            })),
          }
          : {}),
      };
    });
    const imported = await native.api.experimental.session.import({
      info,
      location: info.location,
      messages: rows,
    });
    if (imported.location.directory !== native.directory) {
      throw new Error("Historical fixture import changed its native directory");
    }
  }
  return { ...session, messages };
}

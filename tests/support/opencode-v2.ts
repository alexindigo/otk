// SPDX-License-Identifier: LGPL-3.0-only
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { join } from "@std/path";
import type { ChildProcess } from "node:child_process";
import {
  discoverV2,
  opencodeV2SessionID as ids,
  serviceHeaders,
} from "@otk/harness-opencode-v2-server";
import type { FakeLlm } from "./fake-llm.ts";
import { acquire, resources, tempDir } from "./resources.ts";
import { ownedProcess } from "./process.ts";
import { waitFor } from "./opencode.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { FreezeProxy } from "./freeze-proxy.ts";
import type { NativeFixture } from "./native-fixture.ts";
import { nativeListeningURL } from "./native-announcement.ts";

/** Stock managed V2 service, private HOME/XDG and test-owned discovery proxy. */
export class OpencodeV2Test implements NativeFixture {
  readonly kind = "opencode-v2-server" as const;
  readonly version = nativeVersion;
  root!: string;
  directory!: string;
  url!: string;
  nativePort!: number;
  db!: string;
  serviceFile!: string;
  registration!: string;
  discoveryEnv!: Record<string, string>;
  api!: OpenCodeClient;
  nativeApi!: OpenCodeClient;
  process!: ChildProcess;
  proxy!: FreezeProxy;
  log = "";
  #env: Record<string, string> = {};
  #logPath = "";
  #stop: () => Promise<void> = () => Promise.resolve();
  static async start(provider: FakeLlm, options: {
    config?: Record<string, unknown>;
    env?: Record<string, string>;
    prepare?(fixture: OpencodeV2Test): Promise<void>;
  } = {}): Promise<OpencodeV2Test> {
    if (nativeVersion !== "2.2.6") {
      throw new Error(`V2 fixture requires 2.2.6, selected ${nativeVersion}`);
    }
    return await acquire("V2 native fixture", async () => {
      const test = new OpencodeV2Test();
      test.root = await tempDir("oc-v2-");
      test.directory = join(test.root, "project");
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        ...options.env,
      };
      for (
        const [key, name] of Object.entries({
          HOME: "home",
          TMPDIR: "tmp",
          XDG_CONFIG_HOME: "config",
          XDG_DATA_HOME: "data",
          XDG_STATE_HOME: "state",
          XDG_CACHE_HOME: "cache",
        })
      ) {
        env[key] = join(test.root, name);
        await Deno.mkdir(env[key], { recursive: true });
      }
      await Deno.mkdir(test.directory);
      const git = await new Deno.Command("git", {
        args: ["init", "-b", "master", test.directory],
        env,
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!git.success) throw new Error(new TextDecoder().decode(git.stderr));
      await options.prepare?.(test);
      await Deno.mkdir(join(env.XDG_CONFIG_HOME, "opencode"));
      await Deno.writeTextFile(
        join(env.XDG_CONFIG_HOME, "opencode/opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "fake/scripted",
          providers: {
            fake: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: {
                baseURL: `http://127.0.0.1:${provider.port}/v1`,
                apiKey: "x",
              },
              models: { scripted: { name: "scripted" } },
            },
          },
          permissions: [{ action: "shell", resource: "*", effect: "ask" }],
          ...options.config,
        }),
      );
      test.db = join(env.XDG_DATA_HOME, "opencode/opencode.db");
      test.registration = join(env.XDG_STATE_HOME, "opencode/service.json");
      const logPath = join(
        Deno.env.get("OTK_TEST_LOG_ROOT") ?? test.root,
        "native-v2.log",
      );
      test.#env = env;
      test.#logPath = logPath;
      await test.#start();
      return test;
    });
  }
  async restart(): Promise<void> {
    await this.stop();
    await this.#start();
  }
  async #start(): Promise<void> {
    const env = this.#env, logPath = this.#logPath;
    const offset = this.log.length;
    const owner = ownedProcess(nativeBinary, [
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ], {
      cwd: this.directory,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = owner.child;
    this.#stop = resources().defer("V2 native generation", async () => {
      try {
        await this.proxy?.stop();
      } finally {
        await owner.stop();
      }
    });
    const record = (bytes: Uint8Array) => {
      const text = new TextDecoder().decode(bytes);
      this.log += text;
      Deno.writeTextFileSync(logPath, text, { append: true });
    };
    this.process.stdout!.on("data", record);
    this.process.stderr!.on("data", record);
    try {
      // Admit only this process's own announcement and exact managed identity.
      const announced = await waitFor(
        () => {
          if (this.process.exitCode !== null) {
            throw new Error(`V2 native exited: ${this.log}`);
          }
          return nativeListeningURL(this.log.slice(offset), this.kind);
        },
        Boolean,
        120_000,
      );
      const service = await waitFor(
        () => discoverV2(this.registration),
        (s) =>
          s.pid === this.process.pid && s.version === nativeVersion &&
          s.endpoint.url === announced,
        60_000,
      );
      const endpoint = await Service.discover({
        file: this.registration,
        version: nativeVersion,
      });
      if (!endpoint) throw new Error("V2 managed fixture discovery failed");
      this.api = OpenCode.make({
        baseUrl: endpoint.url,
        headers: serviceHeaders(endpoint),
      });
      this.nativeApi = this.api;
      const signal = AbortSignal.timeout(30_000);
      const stream = await fetch(endpoint.url + "/api/event", {
        headers: serviceHeaders(endpoint),
        signal,
      });
      if (!stream.ok || !stream.body) {
        throw new Error("V2 fixture SSE not accepted");
      }
      const reader = stream.body.getReader();
      try {
        let text = "";
        while (!text.includes('"server.connected"')) {
          const bytes = await reader.read();
          if (bytes.done) {
            throw new Error("V2 fixture SSE ended before connected");
          }
          text += new TextDecoder().decode(bytes.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const location = { directory: this.directory };
      await this.api.agent.list({ location }, { signal });
      await this.api.model.list({ location }, { signal });
      const nativePort = Number(new URL(endpoint.url).port);
      this.nativePort = nativePort;
      this.proxy = new FreezeProxy(nativePort, { port: this.proxy?.port });
      this.url = `http://127.0.0.1:${this.proxy.port}`;
      const state = join(this.root, "discovery");
      await Deno.mkdir(join(state, "opencode"), { recursive: true });
      this.serviceFile = join(state, "opencode/service.json");
      // The live managed record is never replaced: its owner monitors custody.
      const registration = JSON.parse(
        await Deno.readTextFile(this.registration),
      );
      await Deno.writeTextFile(
        this.serviceFile,
        JSON.stringify({ ...registration, url: this.url }),
        { mode: 0o600 },
      );
      this.discoveryEnv = {
        HOME: env.HOME,
        XDG_STATE_HOME: state,
        XDG_DATA_HOME: env.XDG_DATA_HOME,
      };
      this.api = OpenCode.make({
        baseUrl: this.url,
        headers: serviceHeaders(service.endpoint),
      });
    } catch (error) {
      await this.stop();
      throw new Error(`${error}\n${this.log}`, { cause: error });
    }
  }
  async createSession(
    title = "V2 fixture session",
  ): Promise<{ id: string; nativeID: string }> {
    const raw = await this.api.session.create({
      title,
      location: { directory: this.directory },
    });
    return { id: ids.encode(raw.id), nativeID: raw.id };
  }
  async prompt(id: string, text: string): Promise<unknown> {
    const sessionID = ids.decode(id);
    await this.api.session.switchModel({
      sessionID,
      model: { providerID: "fake", id: "scripted" },
    });
    return await this.api.session.prompt({ sessionID, text });
  }
  async listSessions(limit = 20): Promise<{ id: string; nativeID: string }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Invalid fixture page limit");
    }
    const page = await this.api.session.list({
      directory: this.directory,
      limit,
      order: "desc",
    });
    return page.data.map((row) => ({
      id: ids.encode(row.id),
      nativeID: row.id,
    }));
  }
  readSession(id: string): Promise<unknown> {
    return this.api.session.get({ sessionID: ids.decode(id) });
  }
  readMessages(id: string, limit = 10): Promise<unknown> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Invalid fixture page limit");
    }
    return this.api.message.list({
      sessionID: ids.decode(id),
      limit,
      order: "desc",
    });
  }
  async listPermissions(
    id: string,
  ): Promise<{ id: string; sessionID: string }[]> {
    return (await this.api.permission.list({ sessionID: ids.decode(id) })).map((
      row,
    ) => ({ id: row.id, sessionID: ids.encode(row.sessionID) }));
  }
  replyPermission(
    id: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<unknown> {
    return this.api.permission.reply({
      sessionID: ids.decode(id),
      requestID,
      decision,
      ...(message ? { message } : {}),
    });
  }
  stageRevert(id: string, messageID: string, files: boolean): Promise<unknown> {
    return this.api.session.revert.stage({
      sessionID: ids.decode(id),
      messageID,
      files,
    });
  }
  restore(id: string): Promise<unknown> {
    return this.api.session.revert.clear({ sessionID: ids.decode(id) });
  }
  async listForms(id: string): Promise<{ id: string; sessionID: string }[]> {
    return (await this.api.session.form.list({ sessionID: ids.decode(id) }))
      .map((row) => ({
        id: row.id,
        sessionID: row.sessionID === "global"
          ? "global"
          : ids.encode(row.sessionID),
      }));
  }
  answerForm(
    id: string,
    formID: string,
    answer: Record<string, string | number | boolean | string[]>,
  ): Promise<unknown> {
    return this.api.session.form.reply({
      sessionID: ids.decode(id),
      formID,
      answer,
    });
  }
  interrupt(id: string): Promise<unknown> {
    return this.api.session.interrupt({ sessionID: ids.decode(id) });
  }
  async stop(): Promise<void> {
    await this.#stop();
  }
}

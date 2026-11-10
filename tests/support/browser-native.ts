// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import {
  discoverV2,
  opencodeV2SessionID as ids,
  serviceHeaders,
} from "@otk/harness-opencode-v2-server";
import { FakeLlm, type Script } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { OpencodeV2Test } from "./opencode-v2.ts";
import { nativeKind } from "./native.ts";

export type BrowserNative =
  & Omit<Pick<OpencodeTest, keyof OpencodeTest>, "kind">
  & { readonly kind: "opencode-v1" | "opencode-v2-server" };
export type BrowserNativeOptions =
  & Omit<NonNullable<Parameters<typeof OpencodeTest.start>[2]>, "prepare">
  & { prepare?(native: BrowserNative): Promise<void> };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value as ObjectValue;
export const browserSessionID = (id: string) =>
  id.startsWith("opcv")
    ? id
    : `${nativeKind === "opencode-v2-server" ? "opcv2" : "opcv1"}-${id}`;
export const browserNativeID = (id: string) => id.replace(/^opcv[12]-/, "");
/** Semantic observation vocabulary; forwarding always keeps the actual native URL. */
export function browserScenarioPath(
  native: Pick<BrowserNative, "kind">,
  path: string,
  method = "GET",
): string {
  if (native.kind === "opencode-v1") return path;
  path = path.replace(/^\/api(?=\/)/, "");
  if (path === "/event") return "/global/event";
  if (method === "DELETE" && /\/session\/[^/]+\/revert$/.test(path)) {
    return path.replace(/\/revert$/, "/unrevert");
  }
  return path.replace(/\/interrupt$/, "/abort").replace(
    /\/compact$/,
    "/summarize",
  ).replace(/\/revert\/stage$/, "/revert").replace(
    /\/prompt$/,
    "/prompt_async",
  );
}
const nativeToolNames: Record<string, string> = {
  bash: "shell",
  task: "subagent",
  apply_patch: "patch",
};
export const browserToolName = (name: string) => nativeToolNames[name] ?? name;
const fixtureToolName = (name: string) =>
  Object.entries(nativeToolNames).find(([, native]) => native === name)?.[0] ??
    name;
export function browserScript(script: Script): Script {
  if (nativeKind !== "opencode-v2-server" || !script.tool) return script;
  const input = { ...script.tool.input };
  if ("filePath" in input) {
    input.path = input.filePath;
    delete input.filePath;
  }
  if ("workdir" in input) {
    input.cwd = input.workdir;
    delete input.workdir;
  }
  if ("subagent_type" in input) {
    input.agent = input.subagent_type;
    delete input.subagent_type;
  }
  if ("session_id" in input) {
    input.sessionID = input.session_id;
    delete input.session_id;
  }
  if ("task_id" in input) {
    input.sessionID = input.task_id;
    delete input.task_id;
  }
  if (script.tool.name === "skill" && "name" in input) {
    input.id = input.name;
    delete input.name;
  }
  return {
    ...script,
    tool: { name: browserToolName(script.tool.name), input },
  };
}
class BrowserLlm extends FakeLlm {
  override queue(...scripts: Script[]) {
    super.queue(...scripts.map(browserScript));
  }
  override queueHeld(script: Script) {
    return super.queueHeld(browserScript(script));
  }
  override queueStepped(script: Script) {
    return super.queueStepped(browserScript(script));
  }
}
export function browserProvider(): FakeLlm {
  return new BrowserLlm();
}
/** Import initial projected history once on V2; V1 uses its noReply seed API. */
export async function seedBrowserSession(
  oc: BrowserNative,
  body: ObjectValue,
  directory = oc.directory,
) {
  const { messages, ...metadata } = body;
  if (oc instanceof BrowserV2Native) {
    return await oc.seedSession(metadata, messages as ObjectValue[], directory);
  }
  const session = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: metadata,
    directory,
  });
  for (const message of messages as ObjectValue[]) {
    await oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: { ...message, noReply: true },
      directory,
    });
  }
  return session;
}
function model(value: unknown, variant?: unknown): unknown {
  if (typeof value === "string") {
    const [providerID, ...rest] = value.split("/");
    return {
      providerID,
      model: rest.join("/"),
      ...(variant ? { variant } : {}),
    };
  }
  return value;
}
export function browserV2Config(value: ObjectValue = {}): ObjectValue {
  const result = { ...value };
  delete result.autoupdate;
  if (result.model) result.model = model(result.model);
  if (result.agent) {
    result.agents = Object.fromEntries(
      Object.entries(object(result.agent)).map(([id, raw]) => {
        const agent = { ...object(raw) };
        if (agent.model) agent.model = model(agent.model, agent.variant);
        delete agent.variant;
        return [id, agent];
      }),
    );
    delete result.agent;
  }
  if (result.provider) {
    result.providers = Object.fromEntries(
      Object.entries(object(result.provider)).map(([id, raw]) => {
        const p = object(raw);
        return [id, {
          name: p.name,
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: p.options,
          models: Object.fromEntries(
            Object.entries(object(p.models ?? {})).map(([key, raw]) => {
              const m = { ...object(raw) };
              // V1 custom models without variants are non-reasoning choices.
              // Stock V2 otherwise synthesizes low/medium/high for them.
              if (!m.variants) {
                m.capabilities = {
                  ...object(m.capabilities ?? {}),
                  reasoning: { supported: false },
                };
              }
              if (m.release_date) {
                m.releaseDate = m.release_date;
                delete m.release_date;
              }
              if (m.cost) {
                const cost = { ...object(m.cost) };
                cost.cache = { read: cost.cache_read, write: cost.cache_write };
                delete cost.cache_read;
                delete cost.cache_write;
                m.cost = cost;
              }
              if (m.variants && !Array.isArray(m.variants)) {
                m.variants = Object.entries(object(m.variants)).map((
                  [id, settings],
                ) => ({ id, settings }));
              }
              return [key, m];
            }),
          ),
        }];
      }),
    );
    delete result.provider;
  }
  return result;
}

/** Browser scenario vocabulary over the existing managed V2 launcher.
 * Native shape conversion is confined here; OTK/UI assertions stay unchanged. */
export class BrowserV2Native implements BrowserNative {
  readonly kind = "opencode-v2-server" as const;
  get version() {
    return this.native.version;
  }
  get root() {
    return this.native.root;
  }
  get directory() {
    return this.native.directory;
  }
  get url() {
    return this.native.url;
  }
  get port() {
    return this.native.proxy.port;
  }
  get nativePort() {
    return this.native.nativePort;
  }
  get nativeURL() {
    return `http://127.0.0.1:${this.nativePort}`;
  }
  get db() {
    return this.native.db;
  }
  get process() {
    return this.native.process;
  }
  get log() {
    return this.native.log;
  }
  get discoveryEnv() {
    return this.native.discoveryEnv;
  }
  constructor(readonly native: OpencodeV2Test) {}
  static async start(
    fake: FakeLlm,
    permission: Record<string, "ask" | "allow" | "deny"> = { bash: "ask" },
    options: BrowserNativeOptions = {},
  ): Promise<BrowserV2Native> {
    const config = browserV2Config(options.config);
    config.providers = {
      ...object(config.providers ?? {}),
      fake: {
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "x" },
        models: {
          scripted: { name: "scripted" },
          "gpt-scripted": { name: "gpt-scripted" },
        },
      },
      ...Object.fromEntries(
        Object.entries(options.providers ?? {}).map((
          [id, entry],
        ) => [
          id,
          object(
            browserV2Config({
              provider: {
                [id]: {
                  name: entry.name,
                  options: {
                    baseURL: `http://127.0.0.1:${entry.fake.port}/v1`,
                    apiKey: "x",
                  },
                  models: entry.models,
                },
              },
            }).providers,
          )[id],
        ]),
      ),
    };
    config.permissions = Object.entries(permission).map(([action, effect]) => ({
      action: browserToolName(action),
      resource: "*",
      effect,
    }));
    const native = await OpencodeV2Test.start(fake, {
      config,
      env: { ...options.env, OPENCODE_CONFIG_PROJECT_DISABLE: "0" },
      prepare: async (native) => {
        await Deno.writeTextFile(
          join(native.directory, "README.md"),
          "# OTK fixture\n",
        );
        await options.prepare?.(new BrowserV2Native(native));
      },
    });
    const alias = join(
      Deno.env.get("OTK_TEST_LOG_ROOT") ?? native.root,
      "native.log",
    );
    try {
      await Deno.symlink("native-v2.log", alias);
    } catch (error) {
      // Multiple native stacks share this controller's append-only evidence log.
      if (
        !(error instanceof Deno.errors.AlreadyExists) ||
        await Deno.readLink(alias) !== "native-v2.log"
      ) throw error;
    }
    return new BrowserV2Native(native);
  }
  async endpoint(url: string): Promise<BrowserV2Native> {
    const state = join(this.root, `browser-discovery-${crypto.randomUUID()}`);
    await Deno.mkdir(join(state, "opencode"), { recursive: true });
    const record = JSON.parse(await Deno.readTextFile(this.native.serviceFile));
    await Deno.writeTextFile(
      join(state, "opencode/service.json"),
      JSON.stringify({ ...record, url }),
      { mode: 0o600 },
    );
    return new Proxy(this, {
      get: (target, key) =>
        key === "discoveryEnv"
          ? { ...target.discoveryEnv, XDG_STATE_HOME: state }
          : Reflect.get(target, key, target),
    });
  }
  async seedSession(
    metadata: ObjectValue,
    messages: ObjectValue[],
    directory = this.directory,
  ) {
    const id = typeof metadata.id === "string"
        ? browserNativeID(metadata.id)
        : "ses_" + crypto.randomUUID().replaceAll("-", ""),
      now = Date.now();
    const info = {
      id,
      projectID: "global",
      location: { directory },
      title: String(metadata.title ?? "Fixture session"),
      ...(metadata.parentID
        ? { parentID: browserNativeID(String(metadata.parentID)) }
        : {}),
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: now, updated: now },
    };
    const data = messages.flatMap((message, n) =>
      typeof message.type === "string"
        ? [{
          ...message,
          id: message.id ?? "msg_" + crypto.randomUUID().replaceAll("-", ""),
          time: message.time ?? { created: now + n },
        }]
        : [
          ...(message.agent
            ? [{
              id: "msg_" + crypto.randomUUID().replaceAll("-", ""),
              type: "agent-switched",
              agent: message.agent,
              time: { created: now + n },
            }]
            : []),
          ...(message.model
            ? [{
              id: "msg_" + crypto.randomUUID().replaceAll("-", ""),
              type: "model-switched",
              model: {
                providerID: object(message.model).providerID,
                id: object(message.model).modelID,
                ...(message.variant ? { variant: message.variant } : {}),
              },
              time: { created: now + n },
            }]
            : []),
          {
            id: "msg_" + crypto.randomUUID().replaceAll("-", ""),
            type: "user",
            text: (message.parts as ObjectValue[]).filter((p) =>
              p.type === "text"
            )
              .map((p) => p.text).join(""),
            time: { created: now + n },
            files: (message.parts as ObjectValue[]).filter((p) =>
              p.type === "file"
            )
              .map((p) => ({
                data: String(p.url).split(",", 2)[1],
                source: { type: "inline" },
                name: String(p.filename ?? "attachment"),
                mime: String(p.mime ?? "text/plain"),
              })),
          },
        ]
    );
    const raw = await this.native.api.experimental.session.import({
      info,
      messages: JSON.parse(JSON.stringify(data)),
      location: { directory },
    });
    return { ...raw, id: ids.encode(raw.id), directory, nativeID: raw.id };
  }
  async session<T extends { id: string }>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T & { nativeID: string }> {
    const raw = await this.request<T>(path, options);
    return {
      ...raw,
      id: ids.encode(raw.id),
      nativeID: raw.id,
      ...(Reflect.get(raw, "parentID")
        ? { parentID: ids.encode(String(Reflect.get(raw, "parentID"))) }
        : {}),
    };
  }
  async sessionList<T extends { id: string }>(
    path: string,
    directory?: string,
  ): Promise<(T & { nativeID: string })[]> {
    return (await this.request<T[]>(path, { directory })).map((raw) => ({
      ...raw,
      id: ids.encode(raw.id),
      nativeID: raw.id,
      ...(Reflect.get(raw, "parentID")
        ? { parentID: ids.encode(String(Reflect.get(raw, "parentID"))) }
        : {}),
    }));
  }
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    try {
      return await this.#request<T>(path, options);
    } catch (cause) {
      // Keep HTTP vocabulary in the browser control protocol even when the SDK
      // decodes a native tagged error instead of exposing the Response.
      let error = cause;
      const seen = new Set<object>();
      while (error && typeof error === "object" && !seen.has(error)) {
        seen.add(error);
        if (Reflect.get(error, "_tag") === "SessionNotFoundError") {
          throw new Error(`404: ${String(Reflect.get(error, "message"))}`, {
            cause,
          });
        }
        error = Reflect.get(error, "cause");
      }
      throw cause;
    }
  }
  async #request<T>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    const method = options.method ?? "GET",
      directory = options.directory ?? this.directory;
    path = path.replace(/opcv2-(ses_[a-zA-Z0-9]+)/g, "$1");
    const uri = new URL("http://fixture" + path);
    const parts = uri.pathname.split("/").filter(Boolean), sessionID = parts[1];
    const b = object(options.body ?? {}), api = this.native.api;
    let result: unknown;
    if (path === "/experimental/tool/ids") {
      await api.model.list({ location: { directory } });
      return await api.agent.list({ location: { directory } }) as T;
    } else if (parts[0] === "session" && parts.length === 1) {
      if (method === "POST") {
        result = await api.session.create({
          title: String(b.title ?? "Fixture session"),
          ...(b.parentID
            ? { parentID: browserNativeID(String(b.parentID)) }
            : { location: { directory } }),
        });
      } else {
        const rows: unknown[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.session.list({
            directory,
            limit: 200,
            ...(cursor ? { cursor } : { order: "desc" }),
          });
          rows.push(...page.data);
          cursor = page.cursor.next ?? undefined;
        } while (cursor);
        result = rows;
      }
    } else if (path === "/session/status") {
      result = await api.session.active();
    } else if (parts[0] === "session" && parts[2] === "children") {
      result =
        (await api.session.list({ parentID: sessionID, limit: 200 })).data;
    } else if (parts[0] === "session" && parts[2] === "inbox") {
      result = await api.session.inbox.list({ sessionID });
    } else if (parts[0] === "session" && parts.length === 2) {
      if (method === "DELETE") result = await api.session.remove({ sessionID });
      else if (method === "PATCH") {
        await api.session.update({ sessionID, ...b });
        result = await api.session.get({ sessionID });
      } else result = await api.session.get({ sessionID });
    } else if (
      parts[0] === "session" &&
      ["message", "prompt_async"].includes(parts[2]) && method === "POST"
    ) {
      if (b.noReply) {
        throw new Error(
          "V2 transcript seeds must use an imported session, not V1 noReply",
        );
      }
      if (typeof b.agent === "string") {
        await api.session.switchAgent({ sessionID, agent: b.agent });
      }
      if (b.model) {
        const m = object(b.model);
        await api.session.switchModel({
          sessionID,
          model: {
            providerID: String(m.providerID),
            id: String(m.modelID),
            ...(b.variant ? { variant: String(b.variant) } : {}),
          },
        });
      }
      const input = (b.parts ?? []) as ObjectValue[];
      result = await api.session.prompt({
        sessionID,
        text: input.filter((p) => p.type === "text").map((p) => p.text).join(
          "",
        ),
        files: input.filter((p) => p.type === "file").map((p) => ({
          uri: String(p.url),
          name: String(p.filename ?? "attachment"),
        })),
      });
      if (parts[2] === "message") {
        await api.experimental.session.wait({ sessionID });
        result = (await api.message.list({
          sessionID,
          limit: 1,
          order: "desc",
          type: "assistant",
        })).data[0];
        return messageFixture(result) as T;
      }
    } else if (parts[0] === "session" && parts[2] === "message") {
      result = parts[3]
        ? await api.session.message.get({ sessionID, messageID: parts[3] })
        : (await api.message.list({
          sessionID,
          limit: Number(uri.searchParams.get("limit") ?? 200),
          order: "asc",
        })).data;
      let agent: unknown, selectedModel: unknown;
      return (Array.isArray(result)
        ? result.flatMap((raw, index, rows) => {
          const row = object(raw);
          if (row.type === "agent-switched") agent = row.agent;
          if (row.type === "model-switched") selectedModel = row.model;
          if (
            !["agent-switched", "model-switched", "location-switched", "idle"]
              .includes(String(object(raw).type))
          ) {
            // V2 stores chosen selection in control rows and effective selection
            // on the assistant, not on user input. Observe the actual next reply
            // (bounded by the next input), including native agent defaults.
            let applied: ObjectValue | undefined;
            if (row.type === "user") {
              for (let next = index + 1; next < rows.length; next++) {
                const candidate = object(rows[next]);
                if (["user", "shell"].includes(String(candidate.type))) break;
                if (candidate.type === "assistant") {
                  applied = candidate;
                  break;
                }
              }
            }
            return [
              messageFixture({
                ...row,
                ...((applied?.agent ?? agent)
                  ? { agent: applied?.agent ?? agent }
                  : {}),
                ...((applied?.model ?? selectedModel)
                  ? { model: applied?.model ?? selectedModel }
                  : {}),
              }),
            ];
          }
          return [];
        })
        : messageFixture(result)) as T;
    } else if (
      parts[0] === "session" && parts[2] === "revert" && method === "POST"
    ) {
      result = await api.session.revert.stage({
        sessionID,
        messageID: String(b.messageID),
        files: b.files === true,
      });
    } else if (parts[0] === "session" && parts[2] === "abort") {
      result = await api.session.interrupt({ sessionID });
    } else if (path === "/permission") {
      result =
        (await api.permission.request.list({ location: { directory } })).data;
    } else if (parts[0] === "permission" && parts[2] === "reply") {
      const pending =
        (await api.permission.request.list({ location: { directory } })).data
          .find((p) => p.id === parts[1]);
      if (!pending) throw new Error("Permission is no longer pending");
      result = await api.permission.reply({
        sessionID: pending.sessionID,
        requestID: pending.id,
        decision: String(b.reply) as "once" | "always" | "reject",
        ...(b.message ? { message: String(b.message) } : {}),
      });
    } else if (parts[0] === "question") {
      const pending = (await api.form.list({ location: { directory } })).data
        .filter((f) => f.metadata?.kind === "question");
      if (method === "GET") {
        result = pending.map((form) => ({
          id: form.id,
          sessionID: form.sessionID,
          questions: form.fields.map((f) => ({
            header: f.title,
            question: f.description,
            options: "options" in f ? f.options : [],
            multiple: f.type === "multiselect",
            custom: "custom" in f ? f.custom : true,
          })),
        }));
      } else {
        const form = pending.find((f) => f.id === parts[1]);
        if (!form) throw new Error("Question form is no longer pending");
        if (parts[2] === "reject") {
          result = await api.session.form.cancel({
            sessionID: form.sessionID,
            formID: form.id,
          });
        } else {
          const answers = b.answers as string[][];
          const answer = Object.fromEntries(
            form.fields.map((
              f,
              n,
            ) => [
              f.key,
              f.type === "multiselect" ? answers[n] : answers[n]?.[0] ?? "",
            ]),
          );
          result = await api.session.form.reply({
            sessionID: form.sessionID,
            formID: form.id,
            answer,
          });
        }
      }
    } else {
      const service = await discoverV2(this.native.serviceFile);
      const url = new URL(this.url + "/api" + path);
      const response = await fetch(url, {
        method,
        headers: {
          ...serviceHeaders(service.endpoint),
          "Content-Type": "application/json",
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        throw new Error(`${response.status}: ${await response.text()}`);
      }
      result = response.status === 204 ? undefined : await response.json();
    }
    if (Array.isArray(result)) return result.map(sessionFixture) as T;
    if (result && typeof result === "object" && "location" in result) {
      return sessionFixture(result) as T;
    }
    return result as T;
  }
  createSession(title?: string) {
    return this.session<{ id: string }>("/session", {
      method: "POST",
      body: { title },
    });
  }
  listSessions(limit = 20) {
    return this.sessionList<{ id: string }>(`/session?limit=${limit}`);
  }
  readSession(id: string) {
    return this.request(`/session/${id}`);
  }
  readMessages(id: string, limit = 10) {
    return this.request(`/session/${id}/message?limit=${limit}`);
  }
  prompt(id: string, text: string) {
    return this.native.prompt(id, text);
  }
  interrupt(id: string) {
    return this.native.interrupt(id);
  }
  listPermissions(id: string) {
    return this.native.listPermissions(id);
  }
  replyPermission(
    id: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ) {
    return this.native.replyPermission(id, requestID, decision, message);
  }
  stageRevert(id: string, messageID: string, files: boolean) {
    return this.native.stageRevert(id, messageID, files);
  }
  restore(id: string) {
    return this.native.restore(id);
  }
  restart() {
    return this.native.restart();
  }
  stop() {
    return this.native.stop();
  }
}
function sessionFixture(raw: unknown): unknown {
  const row = object(raw);
  return row?.location
    ? { ...row, directory: object(row.location).directory }
    : row;
}
function messageFixture(raw: unknown): unknown {
  if (!raw) return raw;
  const row = object(raw), time = object(row.time ?? {});
  return {
    info: {
      ...row,
      role: row.type,
      time,
      ...(row.model
        ? {
          model: {
            providerID: object(row.model).providerID,
            modelID: object(row.model).id,
            ...(object(row.model).variant &&
                object(row.model).variant !== "default"
              ? { variant: object(row.model).variant }
              : {}),
          },
        }
        : {}),
    },
    parts: row.type === "user"
      ? [
        { type: "text", text: row.text },
        ...((row.files ?? []) as ObjectValue[]).map((f) => ({
          type: "file",
          filename: f.name,
          mime: f.mime,
          url: `data:${f.mime};base64,${f.data}`,
        })),
        ...((row.agents ?? []) as ObjectValue[]).map((a) => ({
          type: "agent",
          name: a.name,
        })),
      ]
      : Array.isArray(row.content)
      ? row.content.map((value) => {
        const part = object(value);
        if (part.type !== "tool") {
          return {
            ...part,
            messageID: row.id,
            ...(["text", "reasoning"].includes(String(part.type)) &&
                time.streamed !== undefined
              ? { time: { ...object(part.time ?? {}), end: time.streamed } }
              : {}),
          };
        }
        const state = object(part.state),
          metadata = object(state.metadata ?? {});
        const content = Array.isArray(state.content)
          ? state.content.map(object)
          : [];
        return {
          ...part,
          messageID: row.id,
          tool: fixtureToolName(String(part.name)),
          state: {
            ...state,
            time: {
              ...object(state.time ?? {}),
              start: object(part.time ?? {}).ran ??
                object(part.time ?? {}).created,
              end: object(part.time ?? {}).completed,
            },
            metadata: {
              ...metadata,
              ...(metadata.sessionID ? { sessionId: metadata.sessionID } : {}),
            },
            output: typeof metadata.output === "string"
              ? metadata.output
              : content.filter((part) => part.type === "text").map((part) =>
                part.text
              ).join("\n"),
          },
        };
      })
      : [],
  };
}

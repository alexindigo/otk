// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { opencodeV1SessionID as ids } from "@otk/harness-opencode-v1";
import { nativeBinary, nativeVersion } from "./native.ts";
import { freePort, waitFor } from "./opencode.ts";
import { ownedProcess } from "./process.ts";
import { resources, withResources } from "./resources.ts";
import { seedProviderPackages } from "./provider-cache.ts";
import { FakeLlm } from "./fake-llm.ts";

export const SCALE = {
  sessions: 4615,
  projectSessions: 251,
  projectMessages: 27205,
  largestMessages: 1525,
  largestParts: 5672,
};
export interface ExpectedUsage {
  messages: number;
  calls: number;
  cost: number | null;
  tokens: (number | null)[];
  turns: Record<
    string,
    { calls: number; cost: number | null; tokens: (number | null)[] }
  >;
}
export interface ScaleManifest {
  version: string;
  schema: unknown[];
  migrations: unknown[];
  counts: typeof SCALE;
  directory: string;
  db: string;
  sessions: {
    id: string;
    nativeID: string;
    directory: string;
    title: string;
    expected: ExpectedUsage;
  }[];
}

/** Own stock-server lifecycle and disk-backed XDG tree; never uses operator state. */
export class SessionScale {
  readonly port = freePort();
  readonly url = `http://127.0.0.1:${this.port}`;
  readonly directory: string;
  readonly db: string;
  manifest!: ScaleManifest;
  #env: Record<string, string>;
  #process?: ReturnType<typeof ownedProcess>;
  log = "";
  private constructor(readonly root: string, fake: FakeLlm) {
    this.directory = join(root, "project");
    this.db = join(root, "data/opencode/opencode.db");
    this.#env = {
      ...Deno.env.toObject(),
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      TMPDIR: join(root, "tmp"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      OTK_SCALE_PROVIDER: String(fake.port),
    };
  }
  static async create(
    root: string,
    fixtureRoot: string,
    fake: FakeLlm,
  ): Promise<SessionScale> {
    const parent = await Deno.realPath(fixtureRoot);
    root = resolve(root);
    root = join(await Deno.realPath(dirname(root)), basename(root));
    const rel = relative(parent, root);
    if (
      !isAbsolute(root) || !rel || rel.startsWith("..") || isAbsolute(rel) ||
      ["/tmp", "/run", "/dev/shm"].some((p) =>
        parent === p || parent.startsWith(p + "/")
      )
    ) {
      throw new Error(
        "Scale destination must be inside the supplied disk-backed guest fixture root",
      );
    }
    // mkdir without recursive deliberately refuses an existing destination.
    await Deno.mkdir(root, { mode: 0o700 });
    const f = new SessionScale(root, fake);
    resources().defer("scale native", () => f.stop());
    for (
      const name of [
        "project",
        "background",
        "tmp",
        "config/opencode",
        "data",
        "state",
        "cache",
      ]
    ) {
      await Deno.mkdir(join(root, name), { recursive: true });
    }
    const git = await new Deno.Command("git", {
      args: ["init", "-b", "master", f.directory],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!git.success) throw new Error(new TextDecoder().decode(git.stderr));
    await seedProviderPackages(join(root, "config/opencode"));
    await seedProviderPackages(join(f.directory, ".opencode"));
    await Deno.writeTextFile(
      join(root, "config/opencode/opencode.json"),
      JSON.stringify({
        autoupdate: false,
        share: "disabled",
        model: "fake/scripted",
        permission: { bash: "ask" },
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `http://127.0.0.1:${fake.port}/v1`,
              apiKey: "x",
            },
            models: { scripted: { name: "scripted" } },
          },
        },
      }),
    );
    await f.start();
    console.info("Scale bootstrap ready", nativeVersion);
    const sample = await f.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Scale bootstrap" },
    });
    await f.stop();
    console.info("Scale bootstrap stopped; seeding characterized tables");
    f.#seed(sample.id);
    await Deno.writeTextFile(
      join(root, "manifest.json"),
      JSON.stringify(f.manifest, null, 2),
    );
    await f.start();
    console.info("Scale populated native restarted", SCALE);
    const catalog = await f.request<{ id: string }[]>(
      "/experimental/session?limit=200",
    );
    if (
      !catalog.length ||
      !catalog.every((row) =>
        f.manifest.sessions.some((s) => s.nativeID === row.id)
      )
    ) throw new Error("Stock catalog refused generated sessions");
    const page = await f.request<{ info: { id: string } }[]>(
      `/session/${f.manifest.sessions[0].nativeID}/message?limit=10`,
    );
    if (
      page.length !== 10 || !page.every((row) => row.info.id.startsWith("msg_"))
    ) throw new Error("Stock message page refused generated records");
    return f;
  }
  #seed(sampleID: string) {
    if (this.#process) throw new Error("Never seed a running native database");
    const db = new DatabaseSync(this.db);
    try {
      const schema = db.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all();
      const migrations = db.prepare("SELECT * FROM migration ORDER BY id")
        .all();
      const sample = db.prepare("SELECT * FROM session WHERE id=?").get(
        sampleID,
      )!;
      const insert = db.prepare(
        "INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated,time_archived,revert) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );
      const message = db.prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
      );
      const part = db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      );
      this.manifest = {
        version: nativeVersion,
        schema,
        migrations,
        counts: { ...SCALE },
        directory: this.directory,
        db: this.db,
        sessions: [],
      };
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      db.prepare("DELETE FROM session WHERE id=?").run(sampleID);
      const clock = 1700000000000;
      db.prepare(
        "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES(?,?,?,?,?)",
      ).run(
        "scale_background",
        join(this.root, "background"),
        clock,
        clock,
        "[]",
      );
      let globalMessage = 0;
      for (let i = 0; i < SCALE.sessions; i++) {
        const nativeID = `ses_scale${String(i).padStart(6, "0")}`;
        const directory = i < SCALE.projectSessions
          ? this.directory
          : join(this.root, "background");
        const title = `Scale session ${String(i).padStart(4, "0")}`;
        const parent = i >= 10 && i < 40
          ? `ses_scale${String(i - 1).padStart(6, "0")}`
          : i === 40
          ? "ses_missing_parent"
          : i === 5
          ? "ses_scale000004"
          : null;
        const n = i === 0
          ? 1525
          : i > 0 && i < 251
          ? 102 + (i <= 180 ? 1 : 0)
          : i % 3 === 0
          ? 2
          : 0;
        const expected: ExpectedUsage = {
          messages: n,
          calls: Math.floor(n / 2),
          cost: 0,
          tokens: [0, 0, 0, 0, 0],
          turns: {},
        };
        insert.run(
          nativeID,
          i < SCALE.projectSessions ? sample.project_id : "scale_background",
          parent,
          `scale-${i}`,
          directory,
          title,
          nativeVersion,
          clock + i,
          clock + i,
          i === 250 ? clock : null,
          i === 6
            ? JSON.stringify({
              messageID: `msg_scale${
                String(globalMessage + 2).padStart(9, "0")
              }`,
            })
            : null,
        );
        let turn = "";
        for (let m = 0; m < n; m++) {
          const id = `msg_scale${String(globalMessage++).padStart(9, "0")}`;
          const time = clock + m * 10;
          let data: Record<string, unknown>;
          if (m % 2 === 0) {
            turn = id;
            data = {
              role: "user",
              time: { created: time },
              agent: "build",
              model: { providerID: "fake", modelID: "scripted" },
            };
          } else {
            const values = i === 2 ? [0, 0, 0, 0, 0] : [100 + m, 20, 3, 40, 5];
            const cost = i === 2 ? 0 : i === 3 ? .000001 : .001;
            const unknown = i === 1;
            data = {
              role: "assistant",
              parentID: turn,
              time: { created: time, completed: time + 5 },
              agent: "build",
              providerID: "fake",
              modelID: "scripted",
              mode: "build",
              path: { cwd: directory, root: directory },
              cost: unknown ? undefined : cost,
              tokens: {
                input: unknown ? undefined : values[0],
                output: values[1],
                reasoning: values[2],
                cache: { read: values[3], write: values[4] },
              },
              finish: "stop",
            };
            if (unknown) expected.cost = null;
            else if (expected.cost !== null) expected.cost += cost;
            values.forEach((v, k) => {
              if (unknown && k === 0) expected.tokens[k] = null;
              else if (expected.tokens[k] !== null) expected.tokens[k]! += v;
            });
            expected.turns[turn] = {
              calls: 1,
              cost: unknown ? null : cost,
              tokens: values.map((value, k) =>
                unknown && k === 0 ? null : value
              ),
            };
          }
          message.run(id, nativeID, time, time, JSON.stringify(data));
          const parts = i === 0 ? 3 + (m < 1097 ? 1 : 0) : 1;
          for (let p = 0; p < parts; p++) {
            part.run(
              `prt_${id}_${p}`,
              id,
              nativeID,
              time,
              time,
              JSON.stringify({
                type: "text",
                text: `Scale fixture ${i}/${m}/${p}`,
              }),
            );
          }
        }
        this.manifest.sessions.push({
          id: ids.encode(nativeID),
          nativeID,
          directory,
          title,
          expected,
        });
      }
      const count = (sql: string, ...args: string[]) =>
        Number(db.prepare(sql).get(...args)!.n);
      const actual = {
        sessions: count("SELECT count(*) n FROM session"),
        projectSessions: count(
          "SELECT count(*) n FROM session WHERE directory=?",
          this.directory,
        ),
        projectMessages: count(
          "SELECT count(*) n FROM message WHERE session_id IN (SELECT id FROM session WHERE directory=?)",
          this.directory,
        ),
        largestMessages: count(
          "SELECT count(*) n FROM message WHERE session_id=?",
          "ses_scale000000",
        ),
        largestParts: count(
          "SELECT count(*) n FROM part WHERE session_id=?",
          "ses_scale000000",
        ),
      };
      if (JSON.stringify(actual) !== JSON.stringify(SCALE)) {
        throw new Error(`Wrong scale population: ${JSON.stringify(actual)}`);
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  async start() {
    if (this.#process) throw new Error("Scale server already running");
    const process = this.#process = ownedProcess(nativeBinary, [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(this.port),
    ], {
      cwd: this.directory,
      env: this.#env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [process.child.stdout!, process.child.stderr!]) {
      stream.on("data", (chunk) => {
        this.log += chunk.toString();
        Deno.writeTextFileSync(
          join(this.root, "process.log"),
          chunk.toString(),
          { append: true },
        );
      });
    }
    await waitFor(
      async () => {
        try {
          return await (await fetch(this.url + "/global/health", {
            signal: AbortSignal.timeout(5000),
          })).json();
        } catch (error) {
          return {
            error: String(error),
            cause: String((error as Error).cause),
          };
        }
      },
      (h) => h.healthy && h.version === nativeVersion,
      60000,
    );
  }
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    const url = new URL(this.url + path);
    url.searchParams.set("directory", options.directory ?? this.directory);
    const response = await fetch(url, {
      method: options.method,
      headers: { "Content-Type": "application/json" },
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`${response.status}: ${await response.text()}`);
    }
    return response.status === 204 ? undefined as T : await response.json();
  }
  async stop() {
    const owner = this.#process;
    if (owner) {
      await owner.stop();
      this.#process = undefined;
    }
  }
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (let i = 0; i < Deno.args.length; i += 2) {
    args.set(Deno.args[i], Deno.args[i + 1]);
  }
  const root = args.get("--root");
  if (!root) throw new Error("--root is required");
  for (
    const [flag, key] of [
      ["--sessions", "sessions"],
      ["--project-sessions", "projectSessions"],
      ["--project-messages", "projectMessages"],
      ["--largest-messages", "largestMessages"],
      ["--largest-parts", "largestParts"],
    ] as const
  ) {
    if (args.has(flag) && Number(args.get(flag)) !== SCALE[key]) {
      throw new Error(`${flag} must be ${SCALE[key]}`);
    }
  }
  await withResources("standalone scale generator", async () => {
    const tmp = Deno.env.get("TMPDIR");
    if (!tmp || !isAbsolute(tmp)) {
      throw new Error("An absolute disk-backed guest TMPDIR is required");
    }
    const f = await SessionScale.create(
      root,
      args.get("--fixture-root") ?? resolve(tmp, ".."),
      new FakeLlm(),
    );
    console.info(
      JSON.stringify(
        {
          ...f.manifest,
          sessions: undefined,
          manifest: join(root, "manifest.json"),
        },
        null,
        2,
      ),
    );
    await f.stop();
  });
}

// SPDX-License-Identifier: LGPL-3.0-only
/** Portable V2 scale recipes, admitted only through the stock import API.
 * A V1 database snapshot is never relabeled or written into V2's native tables.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { opencodeV2SessionID as ids } from "@otk/harness-opencode-v2-server";
import { nativeBinary, nativeVersion } from "./native.ts";
import { OpencodeV2Test } from "./opencode-v2.ts";
import { FakeLlm } from "./fake-llm.ts";
import { withResources } from "./resources.ts";
import { digest, exclusive, exists, revision, stateRoot } from "./snapshots.ts";
import {
  type ExpectedUsage,
  SCALE,
  SCALE_VARIANTS,
  type ScaleManifest,
  type ScaleVariant,
  variantOptions,
} from "./session-scale.ts";
import { scaleParts, scaleRole } from "./message-scale-cases.ts";
import { BrowserV2Native } from "./browser-native.ts";

interface Recipe {
  schema: 1;
  version: string;
  binary: string;
  fixture: string;
  variant: ScaleVariant;
  counts: typeof SCALE;
}
export class V2SessionScale {
  readonly sessions: {
    id: string;
    nativeID: string;
    directory: string;
    title: string;
    expected: ExpectedUsage;
  }[] = [];
  private constructor(
    readonly native: OpencodeV2Test,
    readonly variant: ScaleVariant,
  ) {}
  get root() {
    return this.native.root;
  }
  get directory() {
    return this.native.directory;
  }
  get db() {
    return this.native.db;
  }
  get url() {
    return this.native.url;
  }
  get port() {
    return this.native.proxy.port;
  }
  get log() {
    return this.native.log;
  }
  request<T>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    return new BrowserV2Native(this.native).request<T>(path, options);
  }
  get manifest(): ScaleManifest {
    return {
      version: nativeVersion,
      schema: [],
      migrations: [],
      counts: { ...SCALE },
      directory: this.directory,
      db: this.db,
      sessions: this.sessions,
      ...(this.variant === "messages" || this.variant === "messages-payload"
        ? { messageCases: variantOptions(this.variant) }
        : {}),
    };
  }
  stop() {
    return this.native.stop();
  }
  static async identity(variant: ScaleVariant) {
    if (!SCALE_VARIANTS.includes(variant) || !nativeVersion.startsWith("2.")) {
      throw new Error("V2 scale recipe requires a V2 lane and known variant");
    }
    const binary = await digest(nativeBinary),
      fixture = await revision([
        "tests/support/v2-session-scale.ts",
        "tests/support/message-scale-cases.ts",
        "tests/support/opencode-v2.ts",
        "tests/support/native-announcement.ts",
        "tests/support/session-scale.ts",
        "tests/support/native.ts",
        "deno.lock",
      ]);
    return {
      binary,
      fixture,
      key: `${nativeVersion}-${binary}-${fixture}-${variant}`,
    };
  }
  static async validate(path: string): Promise<Recipe> {
    const recipe: Recipe = JSON.parse(
      await Deno.readTextFile(join(path, "recipe.json")),
    );
    const identity = await this.identity(recipe.variant);
    if (
      recipe.schema !== 1 || recipe.version !== nativeVersion ||
      recipe.binary !== identity.binary ||
      recipe.fixture !== identity.fixture ||
      JSON.stringify(recipe.counts) !== JSON.stringify(SCALE)
    ) {
      throw new Error(
        "Invalid V2 scale recipe identity; preserve the invalid key for diagnosis",
      );
    }
    return recipe;
  }
  static async generate(variant: ScaleVariant, fake: FakeLlm): Promise<string> {
    const identity = await this.identity(variant),
      target = join(stateRoot(), "v2-scale", identity.key);
    return await exclusive(target, async () => {
      if (await exists(target)) {
        await this.validate(target);
        return target;
      }
      // Qualify every recipe against a fresh stock managed service before publication.
      await withResources(`qualify V2 ${variant} recipe`, async () => {
        const fixture = await this.build(variant, fake);
        fixture.population();
        const page = await fixture.native.api.message.list({
          sessionID: fixture.sessions[0].nativeID,
          limit: 10,
          order: "desc",
        });
        if (page.data.length !== 10 || !page.cursor.next) {
          throw new Error("Stock V2 refused the scale message page");
        }
      });
      await Deno.mkdir(target);
      await Deno.writeTextFile(
        join(target, "recipe.json"),
        JSON.stringify(
          {
            schema: 1,
            version: nativeVersion,
            binary: identity.binary,
            fixture: identity.fixture,
            variant,
            counts: SCALE,
          } satisfies Recipe,
        ),
      );
      await this.validate(target);
      return target;
    });
  }
  static async materialize(
    path: string,
    fake: FakeLlm,
  ): Promise<V2SessionScale> {
    const recipe = await this.validate(path);
    return await this.build(recipe.variant, fake);
  }
  static async build(
    variant: ScaleVariant,
    fake: FakeLlm,
  ): Promise<V2SessionScale> {
    const native = await OpencodeV2Test.start(fake);
    const fixture = new V2SessionScale(native, variant);
    const control = await native.createSession("Scale import schema");
    const sample = await native.api.session.get({
      sessionID: control.nativeID,
    });
    await native.api.session.remove({ sessionID: control.nativeID });
    const background = join(native.root, "background");
    await Deno.mkdir(background);
    const clock = 1700000000000, options = variantOptions(variant);
    const counts = Array.from(
      { length: SCALE.sessions },
      (_, index) =>
        index === 0
          ? 1525
          : index < 251
          ? 102 + (index <= 180 ? 1 : 0)
          : index % 3 === 0
          ? 2
          : 0,
    );
    const offsets: number[] = [];
    counts.reduce((offset, count, index) => {
      offsets[index] = offset;
      return offset + count;
    }, 0);
    const importSession = async (index: number) => {
      const nativeID = `ses_scale${String(index).padStart(6, "0")}`;
      const directory = index < SCALE.projectSessions
        ? native.directory
        : background;
      const title = `Scale session ${String(index).padStart(4, "0")}`;
      const parentID = index >= 10 && index < 40
        ? `ses_scale${String(index - 1).padStart(6, "0")}`
        : index === 5
        ? "ses_scale000004"
        : undefined;
      const count = index === 0
        ? 1525
        : index < 251
        ? 102 + (index <= 180 ? 1 : 0)
        : index % 3 === 0
        ? 2
        : 0;
      const expected: ExpectedUsage = {
        messages: count,
        calls: 0,
        cost: 0,
        tokens: [0, 0, 0, 0, 0],
        turns: {},
      };
      // V2 Session.Info aggregates are required native facts, independent of
      // optional assistant usage. Keep unknown call categories in the turn
      // manifest, but seed the session's reported aggregates explicitly.
      const nativeTotal = { cost: 0, tokens: [0, 0, 0, 0, 0] };
      let turn = "";
      const messages = Array.from({ length: count }, (_, rank) => {
        const id = `msg_scale${String(offsets[index] + rank).padStart(9, "0")}`;
        const time = clock + rank * 10;
        const parts = Array.from({
          length: index === 0 ? 3 + (rank < 1097 ? 1 : 0) : 1,
        }, (_, part) => scaleParts(index, rank, part, directory, options));
        if (scaleRole(index, rank, options.messages) === "user") {
          turn = id;
          return {
            id,
            type: "user",
            text: parts.map((part) => part.text ?? "").join("\n"),
            time: { created: time },
          };
        }
        expected.calls++;
        const unknown = index === 1,
          cost = index === 2 ? 0 : index === 3 ? .000001 : .001;
        const values = index === 2
          ? [0, 0, 0, 0, 0]
          : [100 + rank, 20, 3, 40, 5];
        if (!unknown) {
          nativeTotal.cost += cost;
          nativeTotal.tokens = nativeTotal.tokens.map((value, at) =>
            value + values[at]
          );
        }
        const total = expected.turns[turn] ??= {
          calls: 0,
          cost: 0,
          tokens: [0, 0, 0, 0, 0],
        };
        total.calls++;
        total.cost = unknown || total.cost === null ? null : total.cost + cost;
        total.tokens = total.tokens.map((value, at) =>
          unknown || value === null ? null : value + values[at]
        );
        const content = parts.map((part) => {
          if (part.type !== "tool") return { type: "text", text: part.text };
          const state = part.state as Record<string, unknown>;
          const input = { ...state.input as Record<string, unknown> };
          if (typeof input.filePath === "string") {
            input.path = input.filePath;
            delete input.filePath;
          }
          if (typeof input.subagent_type === "string") {
            input.agent = input.subagent_type;
            delete input.subagent_type;
          }
          const metadata = { ...state.metadata as Record<string, unknown> };
          if (typeof metadata.sessionId === "string") {
            metadata.sessionID = metadata.sessionId;
            delete metadata.sessionId;
          }
          return {
            type: "tool",
            id: part.callID,
            name: part.tool === "task" ? "subagent" : part.tool,
            time: { created: time, ran: time, completed: time + 5 },
            state: {
              status: "completed",
              input,
              content: [{ type: "text", text: state.output }],
              metadata,
            },
          };
        });
        return {
          id,
          type: "assistant",
          agent: "build",
          model: { providerID: "fake", id: "scripted" },
          content,
          ...(unknown ? {} : {
            cost,
            tokens: {
              input: values[0],
              output: values[1],
              reasoning: values[2],
              cache: { read: values[3], write: values[4] },
            },
          }),
          finish: "stop",
          time: { created: time, streamed: time + 5, completed: time + 5 },
        };
      });
      expected.cost = nativeTotal.cost;
      expected.tokens = [...nativeTotal.tokens];
      await native.api.experimental.session.import({
        info: {
          ...sample,
          id: nativeID,
          parentID,
          title,
          cost: nativeTotal.cost,
          tokens: {
            input: nativeTotal.tokens[0],
            output: nativeTotal.tokens[1],
            reasoning: nativeTotal.tokens[2],
            cache: {
              read: nativeTotal.tokens[3],
              write: nativeTotal.tokens[4],
            },
          },
          time: {
            ...sample.time,
            created: clock + index,
            ...(index === 250 ? { archived: clock } : {}),
          },
        },
        location: { directory },
        messages: JSON.parse(JSON.stringify(messages)),
      });
      fixture.sessions[index] = {
        id: ids.encode(nativeID),
        nativeID,
        directory,
        title,
        expected,
      };
    };
    // Preserve parent-before-child admission. Independent roots can share I/O.
    for (let index = 0; index < 41; index++) await importSession(index);
    for (let start = 41; start < SCALE.sessions; start += 8) {
      await Promise.all(
        Array.from(
          { length: Math.min(8, SCALE.sessions - start) },
          (_, offset) => importSession(start + offset),
        ),
      );
    }
    fixture.population();
    return fixture;
  }
  population() {
    const db = new DatabaseSync(this.native.db, { readOnly: true });
    try {
      const count = (sql: string, ...values: string[]) =>
        Number(db.prepare(sql).get(...values)!.n);
      const actual = {
        sessions: count("SELECT count(*) n FROM session_v2"),
        projectSessions: count(
          "SELECT count(*) n FROM session_v2 WHERE directory=?",
          this.native.directory,
        ),
        projectMessages: count(
          "SELECT count(*) n FROM session_message WHERE session_id IN (SELECT id FROM session_v2 WHERE directory=?)",
          this.native.directory,
        ),
        largestMessages: count(
          "SELECT count(*) n FROM session_message WHERE session_id=?",
          this.sessions[0].nativeID,
        ),
      };
      for (
        const key of [
          "sessions",
          "projectSessions",
          "projectMessages",
          "largestMessages",
        ] as const
      ) {
        if (actual[key] !== SCALE[key]) {
          throw new Error(
            `V2 scale population ${key}: ${actual[key]} != ${SCALE[key]}`,
          );
        }
      }
      return actual;
    } finally {
      db.close();
    }
  }
}

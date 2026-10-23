// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources } from "./analysis.ts";
import { shellPolicyErrors } from "./shell-policy.ts";

const path = "packages/ui/features/prompt/probe.ts";
const feature = (body: string) => `
  import type { PromptRegistry as Registry } from "../../registries/prompt.ts";
  export function install(registry: Registry) {
    registry.register({ id: "probe", create: (context) => {
      ${body}
      return {};
    }});
  }
`;
const errors = (body: string) => shellPolicyErrors(path, feature(body));

Deno.test("submission policy rejects direct native admissions in every browser layer", () => {
  for (const method of ["session.prompt", "session.shell", "session.command"]) {
    for (
      const file of [
        "packages/client/new-feature.ts",
        "packages/ui/features/new-feature.tsx",
        "web/src/features/new-feature.ts",
      ]
    ) {
      assert(
        shellPolicyErrors(
          file,
          `transport.call(${JSON.stringify(method)}, input);`,
        )
          .length > 0,
        `${file}: ${method}`,
      );
    }
  }
});

Deno.test("submission policy accepts real context ports and immutable aliases", () => {
  for (
    const body of [
      `context.submit(() => context.rpc("session.shell", input));`,
      `const port = context, send = port.submit, rpc = port.rpc;
     const method = \`session.command\`;
     send(async () => { await rpc(method, input); });`,
      `const { submit: send, rpc: call } = context;
     send(() => call("session.prompt", input));`,
      `context["submit"](async function () {
       await context["rpc"]("session.shell", input);
     });`,
      `// context.rpc("session.command", input)
     const prose = 'context.rpc("session.shell", input)';`,
    ]
  ) assertEquals(errors(body), [], body);
});

Deno.test("submission policy rejects counterfeit, shadowed and prematurely invoked callbacks", () => {
  for (
    const body of [
      `function submit(action) { return action(); }
     submit(() => context.rpc("session.shell", input));`,
      `const fake = { submit: action => action() };
     fake.submit(() => context.rpc("session.command", input));`,
      `context.submit(context.rpc("session.shell", input));`,
      `context.submit((() => context.rpc("session.shell", input))());`,
      `context.submit(() => {}); context.rpc("session.command", input);`,
      `if (false) context.submit(() => {});
     context.rpc("session.prompt", input);`,
      `context.submit(() => {
       setTimeout(() => context.rpc("session.shell", input), 0);
     });`,
      `context.submit(() => () => context.rpc("session.command", input));`,
      `function leak(context) {
       context.submit(() => context.rpc("session.command", input));
     }`,
      `let send = context.submit; send = action => action();
     send(() => context.rpc("session.shell", input));`,
      `const other = { submit: context.submit, rpc: context.rpc };
     other.submit(() => other.rpc("session.shell", input));`,
      `context.submit = action => action();
     context.submit(() => context.rpc("session.command", input));`,
      `const operation = "session.shell", invoke = context.rpc;
     invoke(operation, input);`,
      `const callback = () => context.rpc("session.command", input);
     context.submit(callback); callback();`,
    ]
  ) assert(errors(body).length > 0, body);
});

Deno.test("submission policy authenticates imported context and registry contracts", () => {
  for (
    const text of [
      `interface PromptContext { submit(action): unknown; rpc(method, input): unknown }
     function run(context: PromptContext) {
       context.submit(() => context.rpc("session.shell", input));
     }`,
      `import type { PromptContext } from "./counterfeit.ts";
     function run(context: PromptContext) {
       context.submit(() => context.rpc("session.command", input));
     }`,
      feature(`context.submit(() => context.rpc("session.shell", input));`)
        .replace("../../registries/prompt.ts", "./counterfeit.ts"),
    ]
  ) assert(shellPolicyErrors(path, text).length > 0, text);
  assertEquals(
    shellPolicyErrors(
      path,
      `
      import type { PromptContext as Context } from "../../registries/prompt.ts";
      function run(port: Context) {
        port.submit(() => port.rpc("session.command", input));
      }
    `,
    ),
    [],
  );
});

Deno.test("submission policy rejects indirect and assembled native admissions", () => {
  for (
    const body of [
      `context.rpc("session." + "shell", input);`,
      `const mode = "command"; context.rpc(\`session.\${mode}\`, input);`,
      `const invoke = context.rpc; invoke.call(context, "session.prompt", input);`,
      `const args = ["session.command", input]; context.rpc.apply(context, args);`,
    ]
  ) assert(errors(body).length > 0, body);
});

Deno.test("submission policy follows the real client factory rather than a submission homonym", () => {
  const file = "packages/client/probe.ts";
  const real = `
    import { createSessionSubmission as bind } from "./session-submission.ts";
    const submission = target => bind({ ...options, sessionID: target.sessionID });
    const send = submission(target);
    send(async () => { await rpc.call("session.prompt", input); });
  `;
  assertEquals(shellPolicyErrors(file, real), []);
  assertEquals(
    shellPolicyErrors(
      file,
      real.replace("const send = submission(target);", "")
        .replace("send(async", "submission(target)(async"),
    ),
    [],
  );
  for (
    const text of [
      real.replace("./session-submission.ts", "./counterfeit.ts"),
      real.replace(
        "target => bind({ ...options, sessionID: target.sessionID })",
        "target => action => action()",
      ),
      real.replace(
        "const send = submission(target);",
        "const send = rpc.call;",
      ),
      real.replace("send(async () => {", "send((async () => {")
        .replace("input); });", "input); })());"),
    ]
  ) assert(shellPolicyErrors(file, text).length > 0, text);
});

Deno.test("submission policy covers recursive production sources including all three shipped paths", async () => {
  const sources = await productionSources();
  for (const [file, text] of sources) {
    if (!file.endsWith(".css")) {
      assertEquals(shellPolicyErrors(file, text), [], file);
    }
  }
  for (
    const file of [
      "packages/client/session-actions.ts",
      "packages/ui/features/prompt/shell.ts",
      "packages/ui/features/prompt/slash.ts",
    ]
  ) {
    const text = sources.get(file)!;
    const bypass = file.includes("session-actions")
      ? text.replace("submission(target)(async () => {", "(async () => {")
        .replace(
          "      });\n    },\n    async abort",
          "      })();\n    },\n    async abort",
        )
      : text.replace(/ctx\.submit\((async )?\(\) =>/g, "counterfeit($1() =>");
    assert(bypass !== text, file);
    assert(shellPolicyErrors(file, bypass).length > 0, file);
  }
});

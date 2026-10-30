// SPDX-License-Identifier: LGPL-3.0-only
// Independent SQLite connection/process for contention and crash-boundary proofs.
import {
  OtkDb,
  type RequestRecord,
  Requests,
  requestsMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";

const [path, inputPath, mode] = Deno.args;
const input: RequestRecord = JSON.parse(await Deno.readTextFile(inputPath));
const db = new OtkDb(path, [requestsMigrations, tasksMigrations]);
const requests = new Requests(db);
if (mode === "admit") {
  const result = requests.admit(input);
  console.log(JSON.stringify({ inserted: result.inserted }));
} else if (mode === "claim") {
  let claimed = false;
  try {
    requests.transition(input, 1, {
      state: "running",
      owner_run: crypto.randomUUID(),
    });
    claimed = true;
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "Request sequence conflict"
    ) throw error;
  }
  console.log(JSON.stringify({ claimed }));
} else {
  const tasks = new Tasks(db);
  requests.admit(input);
  db.write((tx) => {
    const task = tasks.create("/p", "perf", [], tx);
    requests.transition(input, 1, {
      state: "succeeded",
      receipt_kind: "task",
      receipt_json: JSON.stringify(task),
    }, tx);
    if (mode === "before-commit") Deno.exit(77);
  });
  // Simulate loss of the whole process after COMMIT, before delivery.
  Deno.exit(78);
}
db.close();

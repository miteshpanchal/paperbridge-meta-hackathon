import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.mjs";
import { Jobs } from "../server/jobs.mjs";
import { Allowance } from "../server/allowance.mjs";
import { MetaModels } from "../server/models.mjs";
import { evidenceCopy } from "../server/workspaces.mjs";

async function storage(t) {
  const dir = await mkdtemp(join(tmpdir(), "paperbridge-jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(dir);
}
test("duplicate jobs and worker redelivery do not repeat inference; owners cannot inspect other jobs", async (t) => {
  const store = await storage(t),
    owner = randomUUID(),
    paper = { id: randomUUID(), journey: "student" };
  await store.create({ ...paper, owner });
  let calls = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const jobs = new Jobs(store, {}, async () => {
    calls++;
    await gate;
    return { hint: "Test-only result" };
  });
  const [a, b] = await Promise.all([
    jobs.enqueue(owner, paper, "coach", { doubt: "Test" }, "same-operation-id"),
    jobs.enqueue(owner, paper, "coach", { doubt: "Test" }, "same-operation-id"),
  ]);
  const deadline = Date.now() + 5000;
  assert.equal(a.id, b.id);
  while ((await jobs.get(a.id, owner)).status === "QUEUED") {
    assert.ok(Date.now() < deadline, "Job did not start");
    await new Promise((r) => setTimeout(r, 10));
  }
  await jobs.run(a.id);
  assert.equal(calls, 1);
  await assert.rejects(
    () => jobs.get(a.id, randomUUID()),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () =>
      jobs.enqueue(
        owner,
        paper,
        "coach",
        { doubt: "Changed" },
        "same-operation-id",
      ),
    (e) => e.status === 409,
  );
  release();
  while ((await jobs.get(a.id, owner)).status === "RUNNING") {
    assert.ok(Date.now() < deadline, "Job did not finish");
    await new Promise((r) => setTimeout(r, 10));
  }
  const restarted = new Jobs(new Store(store.directory), {}, async () => {
    throw new Error("Must not run again");
  });
  await restarted.run(a.id);
  assert.equal(
    (await restarted.get(a.id, owner)).result.hint,
    "Test-only result",
  );
});
test("an interrupted worker is reported without automatically repeating paid work", async (t) => {
  const store = await storage(t),
    owner = randomUUID(),
    id = randomUUID();
  await store.create({
    id,
    owner,
    kind: "PROCESSING_JOB",
    status: "RUNNING",
    startedAt: Date.now() - 17 * 60000,
    input: { private: "source" },
  });
  let calls = 0;
  const jobs = new Jobs(store, {}, async () => {
    calls++;
  });
  assert.equal((await jobs.get(id, owner)).status, "INTERRUPTED");
  assert.equal((await store.get(id)).input, undefined);
  await jobs.run(id);
  assert.equal(calls, 0);
});
test("daily and session allowances survive restart and reserve costs before permitting a call", async (t) => {
  const store = await storage(t),
    config = {
      JUDGE_EMAIL: "test@example.com",
      META_DAILY_BUDGET_USD: 0.01,
      META_DAILY_REQUEST_LIMIT: 2,
      META_SESSION_REQUEST_LIMIT: 1,
    };
  const allowance = new Allowance(store, config);
  const a = await allowance.reserve("sam-3.1", "session-a");
  await assert.rejects(
    () => allowance.reserve("sam-3.1", "session-a"),
    (e) => e.status === 429,
  );
  await allowance.settle(a);
  const restarted = new Allowance(new Store(store.directory), config);
  assert.equal((await restarted.status("session-a")).requests, 1);
  assert.equal((await restarted.status("session-a")).sessionRequests, 1);
  await assert.rejects(
    () => restarted.reserve("muse-wonder-1.0", "session-b", 2000, 16000),
    (e) => e.status === 429,
  );
  await restarted.reserve("sam-3.1", "session-b");
  await assert.rejects(
    () => restarted.reserve("sam-3.1", "new-login"),
    (e) => e.status === 429,
  );
});
test("worker delivery requires the configured Google-signed identity and audience", async (t) => {
  const store = await storage(t);
  const jobs = new Jobs(
    store,
    {
      TASKS_QUEUE: "projects/test/locations/asia-south1/queues/demo",
      DATA_BUCKET: "test-bucket",
      WORKER_URL: "https://demo.run.app",
      TASKS_SERVICE_ACCOUNT: "worker@example.iam.gserviceaccount.com",
    },
    async () => {},
  );
  await assert.rejects(
    () => jobs.verify(),
    (e) => e.status === 401,
  );
  jobs.auth.verifyIdToken = async (options) => {
    assert.equal(options.audience, "https://demo.run.app");
    return {
      getPayload: () => ({ email: "wrong@example.com", email_verified: true }),
    };
  };
  await assert.rejects(
    () => jobs.verify("Bearer test-only-token"),
    (e) => e.status === 403,
  );
  jobs.auth.verifyIdToken = async () => ({
    getPayload: () => ({
      email: "worker@example.iam.gserviceaccount.com",
      email_verified: true,
    }),
  });
  await jobs.verify("Bearer test-only-token");
});

test("the total allowance survives UTC rollover and late settlement uses the original day", async (t) => {
  const store = await storage(t);
  let date = new Date("2026-11-04T23:59:00Z");
  const config = { META_TOTAL_BUDGET_USD: 0.005, META_DAILY_BUDGET_USD: 0.003 };
  const allowance = new Allowance(store, config, () => date);
  const first = await allowance.reserve("sam-3.1", "a");
  date = new Date("2026-11-05T00:01:00Z");
  await allowance.settle(first);
  assert.equal((await allowance.status("a")).accountedUsd, 0);
  assert.equal((await allowance.status("a")).totalAccountedUsd, 0.0025);
  await allowance.reserve("sam-3.1", "a");
  date = new Date("2026-11-06T00:01:00Z");
  const restarted = new Allowance(
    new Store(store.directory),
    config,
    () => date,
  );
  assert.equal((await restarted.status("a")).totalRemainingUsd, 0);
  await assert.rejects(
    () => restarted.reserve("sam-3.1", "new-login"),
    (e) => e.status === 429,
  );
});

test("token preflight precedes bounded generation and exhausted allowance sends neither request", async (t) => {
  const store = await storage(t),
    config = { MODEL_API_KEY: "test-only-key", META_SESSION_REQUEST_LIMIT: 1 };
  const allowance = new Allowance(store, config),
    calls = [];
  const models = new MetaModels(
    config,
    async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return Response.json(
        url.endsWith("/input_tokens")
          ? { input_tokens: 100 }
          : {
              usage: { prompt_tokens: 100, completion_tokens: 10 },
              choices: [{ message: { content: '{"ok":true}' } }],
            },
      );
    },
    allowance,
  );
  const answer = await models.withActor("a", () =>
    models.chat("muse-spark-1.3", [
      { role: "user", content: "Test-only input" },
    ]),
  );
  assert.deepEqual(answer, { ok: true });
  assert.ok(calls[0].url.endsWith("/responses/input_tokens"));
  assert.ok(calls[1].url.endsWith("/chat/completions"));
  assert.equal(calls[1].body.max_completion_tokens, 12000);
  assert.equal((await allowance.status("a")).reservedUsd, 0);
  await assert.rejects(
    () => models.withActor("a", () => models.chat("muse-spark-1.3", [])),
    (e) => e.status === 429,
  );
  assert.equal(calls.length, 2);
});

test("saved live evidence becomes an independent private paper with no inherited responses or hosting", async (t) => {
  const store = await storage(t),
    owner = randomUUID();
  const source = {
    id: randomUUID(),
    owner: "source-owner",
    mode: "LIVE_UPLOAD",
    hosted: true,
    pages: [{ sourcePage: 2 }, { sourcePage: 3 }],
    marks: 4,
    penalty: 1,
    durationMins: 10,
    questions: [
      {
        id: "source-question",
        page: 1,
        studentResponse: { selectedIndex: 1 },
        audit: { status: "VERIFIED" },
      },
      { page: 2 },
    ],
  };
  const copy = await evidenceCopy(store, source, 0, owner, "student");
  assert.equal(copy.questions.length, 1);
  assert.equal(copy.pages.length, 1);
  assert.equal(copy.questions[0].studentResponse.selectedIndex, null);
  assert.equal(copy.questions[0].audit.status, "VERIFIED");
  assert.notEqual(copy.questions[0].id, source.questions[0].id);
  assert.equal(copy.hosted, undefined);
  assert.equal(source.questions[0].studentResponse.selectedIndex, 1);
  await assert.rejects(
    () => store.get(copy.id, "another-owner"),
    (e) => e.status === 404,
  );
});

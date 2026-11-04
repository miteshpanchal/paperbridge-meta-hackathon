import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/index.mjs";
import { normalizeQuestions } from "../server/domain.mjs";

// Test doubles exercise access and persistence. No fixtures are exposed by production routes.
test("uploaded content → edits → re-audit → responses/OMR → isolated server grading", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "paperbridge-test-"));
  const models = {
    extract: async () =>
      normalizeQuestions(
        [0, 1, 0].map((correctIndex, i) => ({
          text: "Test-only content " + i,
          sourceNumber: String(i + 10),
          correctIndex,
          options: [{ text: "A" }, { text: "B" }],
        })),
      ),
    segment: async () => [],
    auditAndRepair: async (q) => ({
      ...q,
      audit: { status: "VERIFIED", proof: "Test double audit" },
    }),
    readResponses: async () => [
      {
        questionNumber: "10",
        selectedIndex: 1,
        confidence: 0.96,
        evidence: "Test double selection",
        ambiguous: false,
      },
      {
        questionNumber: "11",
        selectedIndex: 0,
        confidence: 0.4,
        evidence: "Ambiguous",
        ambiguous: true,
      },
      { questionNumber: "999", selectedIndex: 0, confidence: 0.99 },
    ],
  };
  const media = async (data) =>
    data.action === "inspect"
      ? { pageCount: 31, offset: data.offset, batchSize: 24, previews: [] }
      : data.action === "pdf"
        ? {
            pages: ["data:image/png;base64,AA=="],
            details: [{ sourcePage: 7 }],
          }
        : data.action === "normalize"
          ? { image: data.image, processing: {} }
          : {
              questions: data.questions.map((q) => ({
                imageUrl: null,
                sourceSnippet: null,
                options: q.options.map(() => null),
              })),
            };
  const server = createApp(
    {
      JUDGE_EMAIL: "judge@example.com",
      JUDGE_PASSWORD: "strong-test-password",
      SESSION_SECRET: "a".repeat(64),
      DATA_DIR: dir,
    },
    { models, media },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const request = async (path, data, headers = {}) => {
    const response = await fetch(base + "/api" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, value: await response.json() };
  };
  assert.equal((await request("/papers", {})).response.status, 401);
  assert.deepEqual((await request("/showcase")).value, { available: false });
  const login = await request("/login", {
    email: "judge@example.com",
    password: "strong-test-password",
  });
  cookie = login.response.headers.get("set-cookie").split(";")[0];
  assert.match(login.response.headers.get("set-cookie"), /HttpOnly/);
  const inspection = await request("/inspect-pdf", {
    base64: "AA==",
    offset: 24,
  });
  assert.equal(
    inspection.response.status,
    200,
    "the upload page browser endpoint is registered",
  );
  assert.equal(inspection.value.pageCount, 31);
  assert.equal(inspection.value.offset, 24);
  assert.equal(
    (await request("/render-pdf", { base64: "AA==", pageNumbers: [6] }))
      .response.status,
    200,
  );
  assert.equal(
    (await request("/papers/sample", {})).response.status,
    404,
    "there is no preloaded content endpoint",
  );
  assert.equal(
    (await request("/papers", {}, { Origin: "https://other.example" })).response
      .status,
    403,
  );
  let paper = (await request("/papers", { name: "Uploaded paper" })).value;
  assert.equal(paper.questions.length, 0);
  assert.equal(paper.mode, "LIVE_UPLOAD");
  const path = "/papers/" + paper.id;
  paper = (
    await request(path + "/pages", {
      image: "data:image/png;base64,AA==",
      pageId: "source-1",
      sourcePage: 7,
    })
  ).value;
  assert.equal(paper.questions.length, 3);
  assert.equal(paper.questions[0].sourcePage, 7);
  assert.equal(
    (await request(path + "/analyze", { answers: [0, 0, null] })).value.score,
    3,
  );
  assert.equal(
    (await request(path + "/analysis")).value.score,
    3,
    "confirmed original responses survive reload",
  );
  const edited = (
    await request(path + "/edit", {
      questionId: paper.questions[0].id,
      question: { text: "Edited uploaded content" },
    })
  ).value;
  assert.equal(edited.questions[0].audit.status, "NEEDS_REVIEW");
  assert.equal((await request(path + "/host", {})).response.status, 422);
  assert.equal(
    (await request(path + "/audit", {})).response.status,
    422,
    "bulk verification is disabled",
  );
  for (const q of edited.questions)
    await request(path + "/audit", { questionId: q.id });
  paper = (await request(path)).value;
  assert.equal(paper.questions[0].text, "Edited uploaded content");
  const detected = (
    await request(path + "/responses", { image: "data:image/png;base64,AA==" })
  ).value;
  assert.equal(detected.responseDetections.length, 2);
  assert.equal(detected.responseDetections[0].selectedIndex, 1);
  assert.equal(detected.responseDetections[1].selectedIndex, null);
  const hosted = (await request(path + "/host", {})).value;
  const visible = (
    await request("/hosted/" + hosted.hostToken, undefined, { Cookie: "" })
  ).value;
  assert.ok(!JSON.stringify(visible).includes("correctIndex"));
  const attempt = (
    await request("/hosted/" + hosted.hostToken + "/start", {}, { Cookie: "" })
  ).value;
  const submit = (answers) =>
    request(
      "/hosted/" + hosted.hostToken + "/submit",
      { attemptToken: attempt.attemptToken, answers },
      { Cookie: "" },
    );
  assert.equal((await submit([0, 1, 0])).value.score, 12);
  assert.equal(
    (await submit([1, 0, 1])).value.score,
    12,
    "resubmission is immutable",
  );
  assert.equal(
    (
      await request(path + "/edit", {
        questionId: paper.questions[0].id,
        question: { text: "After hosting" },
      })
    ).response.status,
    409,
  );
  const second = await request("/login", {
    email: "judge@example.com",
    password: "strong-test-password",
  });
  cookie = second.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await request(path)).response.status, 404);
  assert.equal((await fetch(base + "/vendor/katex/katex.mjs")).status, 200);
  assert.equal((await fetch(base + "/../.env")).status, 404);
});

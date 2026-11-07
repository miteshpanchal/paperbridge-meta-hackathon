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
  const operation={action:"audit",input:{questionId:paper.questions[0].id},requestId:"test-queued-audit"};
  const queued=await request(path+"/jobs",operation);
  assert.equal(queued.response.status,202);
  let job;
  const jobDeadline=Date.now()+5000;
  do { job=(await request("/jobs/"+queued.value.id)).value; if(!["QUEUED","RUNNING"].includes(job.status))break;assert.ok(Date.now()<jobDeadline,"Queued audit did not complete");await new Promise(r=>setTimeout(r,10)); } while(true);
  assert.equal(job.status,"SUCCEEDED",JSON.stringify(job.error));
  assert.equal((await request(path+"/jobs",operation)).value.id,job.id,"A repeated operation resumes the same job");
  assert.equal((await request(path)).value.activeJob,undefined);
  assert.equal(
    (await request(path + "/analyze", { answers: [0, 0, null] })).response
      .status,
    403,
    "Organization papers are not student attempts",
  );
  assert.equal(
    (await request(path, undefined, { "X-PaperBridge-Journey": "student" }))
      .response.status,
    404,
    "Workspace scopes cannot be mixed",
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
  assert.equal((await request(path + "/approve", {})).response.status, 422);
  assert.equal((await request(path)).value.questions[0].audit.status, "NEEDS_REVIEW", "Bulk approval cannot invent an audit");
  const auditBatch = await request(path + "/jobs", {
    action: "audit-selection", input: { questionIds: edited.questions.map((q) => q.id) }, requestId: "test-selected-audit",
  });
  assert.equal(auditBatch.response.status, 202);
  const batchDeadline = Date.now() + 5000;
  let batchJob;
  do {
    batchJob = (await request("/jobs/" + auditBatch.value.id)).value;
    if (!["QUEUED", "RUNNING"].includes(batchJob.status)) break;
    assert.ok(Date.now() < batchDeadline);
    await new Promise((r) => setTimeout(r, 10));
  } while (true);
  assert.equal(batchJob.status, "SUCCEEDED", JSON.stringify(batchJob.error));
  assert.ok((await request(path)).value.questions.every((q) => q.audit.status === "VERIFIED"));
  paper = (await request(path)).value;
  assert.equal(paper.questions[0].text, "Edited uploaded content");
  const hosted = (await request(path + "/host", {})).value;
  const copy = (await request(path + "/share-student", {})).value;
  assert.equal(copy.journey, "student");
  assert.notEqual(copy.id, paper.id);
  assert.equal(copy.hostToken, undefined);
  assert.ok(
    copy.questions.every((q) => q.studentResponse.selectedIndex === null),
  );
  const studentPath = "/papers/" + copy.id;
  assert.equal(
    (await request(studentPath + "/host", {})).response.status,
    403,
    "Student uploads cannot publish organization tests",
  );
  assert.equal(
    (
      await request(studentPath + "/analyze", {
        answers: [0, 0, null],
        confirmed: true,
        responseStates: ["SELECTED", "SELECTED", "UNRESOLVED"],
      })
    ).response.status,
    422,
  );
  const original = (
    await request(studentPath + "/analyze", {
      answers: [0, 0, null],
      confirmed: true,
      responseStates: ["SELECTED", "SELECTED", "SKIPPED"],
    })
  ).value;
  assert.equal(original.score, 3);
  assert.equal((await request(studentPath + "/analysis")).value.score, 3);
  assert.equal(
    (
      await request(studentPath + "/analyze", {
        answers: [1, 1, null],
        confirmed: true,
        responseStates: ["SELECTED", "SELECTED", "SKIPPED"],
      })
    ).response.status,
    409,
    "An original attempt cannot be replaced by new answers",
  );
  const retry = (await request(studentPath + "/retry", {})).value;
  const retryVisible = (await request("/retries/" + retry.token)).value;
  assert.ok(!JSON.stringify(retryVisible).includes("correctIndex"));
  await request("/retries/" + retry.token + "/start", {});
  assert.equal(
    (
      await request("/retries/" + retry.token + "/submit", {
        answers: [0, 1, 0],
      })
    ).value.score,
    12,
  );
  assert.equal(
    (
      await request("/retries/" + retry.token + "/submit", {
        answers: [1, 0, 1],
      })
    ).value.score,
    12,
    "A retry submission is immutable",
  );
  assert.equal(
    (await request(studentPath + "/analysis")).value.score,
    3,
    "A retry preserves the original exam result",
  );
  const detected = (
    await request(studentPath + "/responses", {
      image: "data:image/png;base64,AA==",
    })
  ).value;
  assert.equal(detected.responseDetections.length, 2);
  assert.equal(detected.responseDetections[0].selectedIndex, 1);
  assert.equal(detected.responseDetections[1].selectedIndex, null);
  const orgList = (await request("/papers?journey=organization")).value.papers;
  const studentList = (await request("/papers?journey=student")).value.papers;
  assert.deepEqual(
    orgList.map((p) => p.id),
    [paper.id],
  );
  assert.deepEqual(
    studentList.map((p) => p.id),
    [copy.id],
  );
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
  const draft = (await request("/papers", { name: "Unverified test" })).value;
  const draftPath = "/papers/" + draft.id;
  const bypass = { skipVerification: true };
  assert.equal((await request(draftPath + "/host", bypass)).response.status, 422);
  const extracted = (await request(draftPath + "/pages", {
    image: "data:image/png;base64,AA==",
    pageId: "unverified-source",
    sourcePage: 1,
  })).value;
  assert.equal((await request(draftPath + "/host", {})).response.status, 422);
  const provisionallyHosted = await request(draftPath + "/host", bypass);
  assert.equal(provisionallyHosted.response.status, 200);
  assert.deepEqual(provisionallyHosted.value.questions.map((q) => q.audit), extracted.questions.map((q) => q.audit));
  assert.equal((await request(draftPath + "/publish", bypass)).response.status, 422);
  const publicPath = "/hosted/" + provisionallyHosted.value.hostToken;
  const publicDraft = (await request(publicPath, undefined, { Cookie: "" })).value;
  assert.equal(publicDraft.hostedWithoutVerification, true);
  assert.ok(!JSON.stringify(publicDraft).includes("correctIndex"));
  const provisionalAttempt = (await request(publicPath + "/start", {}, { Cookie: "" })).value;
  const provisionalResult = (await request(publicPath + "/submit", {
    attemptToken: provisionalAttempt.attemptToken,
    answers: [0, 1, 0],
  }, { Cookie: "" })).value;
  assert.equal(provisionalResult.score, 12);
  assert.match(provisionalResult.keyLabel, /^Provisional score/);
  assert.equal((await fetch(base + "/vendor/katex/katex.mjs")).status, 200);
  assert.equal((await fetch(base + "/../.env")).status, 404);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grade,
  normalizeQuestions,
  publicPaper,
  canPublish,
} from "../server/domain.mjs";
import { parseSam, MetaModels } from "../server/models.mjs";
import { ClarifyCueConnector } from "../server/connector.mjs";

const questions = () =>
  normalizeQuestions(
    [0, 1, 0].map((correctIndex, i) => ({
      text: `Q${i}`,
      topic: i === 2 ? "Optics" : "Circuits",
      correctIndex,
      options: [
        { text: "A", misconception: "wrong assumption" },
        { text: "B", misconception: "wrong assumption" },
      ],
    })),
  );
const paper = () => ({
  id: "test",
  name: "Sample",
  marks: 4,
  penalty: 1,
  durationMins: 10,
  mode: "LIVE_UPLOAD",
  questions: questions(),
});
test("negative marking, skipped questions and weaknesses use the exact supplied responses", () => {
  const p = paper();
  const r = grade(p, [0, 0, null]);
  assert.equal(r.score, 3);
  assert.equal(r.maxScore, 12);
  assert.equal(r.correct, 1);
  assert.equal(r.incorrect, 1);
  assert.equal(r.unattempted, 1);
  assert.equal(r.topics[0].topic, "Circuits");
  assert.equal(r.topics[0].lostMarks, 5);
  assert.equal(r.review[1].misconception, "wrong assumption");
  assert.match(r.keyLabel, /Estimated/);
  assert.throws(() => grade(p, [0, NaN, null]), /Invalid answer/);
  assert.throws(() => grade(p, [0]), /one answer/);
});
test("keys and explanations do not leak in the hosted test", () => {
  const p = paper();
  p.questions[0].audit = { status: "VERIFIED", proof: "SECRET" };
  const value = JSON.stringify(publicPaper(p));
  for (const field of [
    "correctIndex",
    "keySource",
    "audit",
    "misconception",
    "explanation",
    "SECRET",
  ])
    assert.ok(!value.includes(field));
});
test("incomplete or unavailable audits block hosting", () => {
  const p = paper();
  assert.equal(canPublish(p), false);
  p.questions.forEach((q) => (q.audit.status = "VERIFIED"));
  assert.equal(canPublish(p), true);
  p.questions[1].audit.status = "UNAVAILABLE";
  assert.equal(canPublish(p), false);
  assert.throws(
    () => normalizeQuestions([{ text: "Numerical", type: "NUMERICAL" }]),
    /single-correct/,
  );
});
test("hosting a reviewed subset excludes incomplete questions from the test and grading",()=>{
  const p=paper();p.questions.forEach(q=>q.audit={status:"VERIFIED"});
  p.questions[2].audit.status="NEEDS_REVIEW";
  p.selectedQuestionIds=p.questions.slice(0,2).map(q=>q.id);
  assert.equal(canPublish(p),true);
  assert.equal(publicPaper(p).questions.length,2);
  assert.equal(grade({...p,hosted:true},[0,1]).maxScore,8);
  assert.equal(grade({...p,hosted:true},[0,1]).score,8);
});
test("SAM source pixels become normalized overlay coordinates without guessing regions", () => {
  assert.deepEqual(
    parseSam(
      "<0f>2<|box;x1=100;y1=200;x2=300;y2=400;w=1000;h=2000;c=0.9|><|mask;data=...|>",
      "diagram",
    ),
    [{ label: "diagram", box: [100, 100, 300, 200], confidence: 0.9 }],
  );
  assert.deepEqual(parseSam("", "graph"), []);
  assert.throws(
    () => parseSam("<|box;x1=0;y1=0;x2=2;y2=2;w=0;h=1|>", "x"),
    /Invalid SAM/,
  );
});
test("an audit failure never turns into verified success", async () => {
  const model = new MetaModels({ MODEL_API_KEY: "test" }, async () => {
    throw new Error("offline");
  });
  const result = await model.audit(
    questions()[0],
    "data:image/png;base64,AA==",
  );
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal((await model.health()).mode, "UNREACHABLE");
  const missing = new MetaModels({});
  assert.equal((await missing.health()).mode, "NOT_CONFIGURED");
  await assert.rejects(
    () => missing.extract("image", [], "Physics"),
    /not configured/,
  );
});
test("Wonder must explicitly agree with the derived answer and provide a proof", async () => {
  const model = new MetaModels(
    { MODEL_API_KEY: "test" },
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verified: true,
                  correctIndex: 1,
                  proof: "Different answer",
                }),
              },
            },
          ],
        }),
      ),
  );
  assert.equal(
    (await model.audit(questions()[0], "image")).status,
    "NEEDS_REVIEW",
  );
});
test("verification requires source fidelity and image bytes never become text tokens", async () => {
  const model = new MetaModels({});
  const question = {
    ...questions()[0],
    sourceSnippet: "data:image/png;base64,SOURCE",
    imageUrl: "data:image/png;base64,DIAGRAM",
  };
  question.options[0].imageUrl = "data:image/png;base64,OPTION";
  let faithful = false;
  const captures = [];
  model.chat = async (_, messages) => {
    captures.push(messages);
    return {
      verified: true,
      sourceFaithful: faithful,
      correctIndex: 0,
      confidence: 0.95,
      proof: "Test-only independent proof",
      hint: "Test-only hint",
    };
  };
  assert.equal(
    (await model.audit(question, question.sourceSnippet)).status,
    "NEEDS_REVIEW",
  );
  faithful = true;
  assert.equal(
    (await model.audit(question, question.sourceSnippet)).status,
    "VERIFIED",
  );
  await model.coach(question, "A test-only doubt");
  for (const messages of captures) {
    const content = messages[1].content;
    assert.ok(content.some((item) => item.type === "image_url"));
    assert.ok(
      content
        .filter((item) => item.type === "text")
        .every((item) => !item.text.includes("data:image")),
    );
  }
  assert.equal(
    captures[2][1].content.find((item) => item.type === "image_url").image_url
      .url,
    question.sourceSnippet,
  );
});

test("connector requires an actual publication and independent read-back", async () => {
  const calls = [];
  const p = paper();
  const connector = new ClarifyCueConnector(
    {
      CLARIFYCUE_API_URL: "http://localhost:3001/api",
      CLARIFYCUE_PAPER_API_KEY: "secret",
      CLARIFYCUE_EXAM_ID: "exam",
    },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({
        testId: "platform-id",
        isPublished: true,
        questionCount: 3,
        externalId: p.id,
      });
    },
  );
  const receipt = await connector.publish(p);
  assert.equal(receipt.testId, "platform-id");
  assert.ok(receipt.readBackVerifiedAt);
  assert.equal(calls.length, 2);
  assert.equal(
    JSON.parse(calls[0].options.body).questions[0].options[0].isCorrect,
    true,
  );
  const failure = new ClarifyCueConnector(
    {
      CLARIFYCUE_API_URL: "http://localhost:3001/api",
      CLARIFYCUE_PAPER_API_KEY: "secret",
      CLARIFYCUE_EXAM_ID: "exam",
    },
    async () => new Response("{}", { status: 500 }),
  );
  await assert.rejects(() => failure.publish(p), /No success receipt/);
});
test("autonomous key repair requires high confidence and a second agreeing audit", async () => {
  const model = new MetaModels({});
  let calls = 0;
  model.audit = async () =>
    ++calls === 1
      ? {
          status: "NEEDS_REVIEW",
          suggestedIndex: 1,
          confidence: 0.95,
          proof: "The cathode points left.",
        }
      : {
          status: "VERIFIED",
          suggestedIndex: 1,
          confidence: 0.96,
          proof: "Independent recheck confirms the positive half-wave.",
        };
  const q = questions()[0];
  const fixed = await model.auditAndRepair(q, "source");
  assert.equal(fixed.correctIndex, 1);
  assert.equal(fixed.audit.status, "VERIFIED");
  assert.equal(fixed.repair.originalIndex, 0);
  assert.equal(fixed.repair.confirmed, true);
  assert.equal(calls, 2);
  calls = 0;
  model.audit = async () => {
    calls++;
    return {
      status: "NEEDS_REVIEW",
      suggestedIndex: 1,
      confidence: 0.5,
      proof: "Ambiguous diagram",
    };
  };
  assert.equal((await model.auditAndRepair(q, "source")).correctIndex, 0);
  assert.equal(calls, 1);
  calls = 0;
  const official = { ...q, keySource: "PROVIDED_KEY" };
  assert.equal(
    (await model.auditAndRepair(official, "source")).correctIndex,
    0,
  );
  assert.equal(calls, 1, "a supplied key is never autonomously overwritten");
});
test("a per-action model request budget is enforced before network execution", async () => {
  let requests = 0;
  const model = new MetaModels({ MODEL_API_KEY: "test" }, async () => {
    requests++;
    return Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
    });
  });
  const execution = await model.withBudget(2, async () => {
    await model.chat("muse-spark-1.3", []);
    await model.chat("muse-spark-1.3", []);
    await assert.rejects(
      () => model.chat("muse-wonder-1.0", []),
      /request cap/,
    );
  });
  assert.equal(requests, 2);
  assert.equal(execution.usage.used, 2);
  assert.equal(execution.usage.models["muse-spark-1.3"], 2);
});

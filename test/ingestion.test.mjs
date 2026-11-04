import { test } from "node:test";
import assert from "node:assert/strict";
import { MetaModels } from "../server/models.mjs";
import { digitizePage } from "../server/ingestion.mjs";
import { normalizeQuestions } from "../server/domain.mjs";

test("text-only digitization uses one Spark call and never invokes SAM or Wonder", async () => {
  let networkCalls = 0;
  const models = new MetaModels({ MODEL_API_KEY: "test" }, async () => {
    networkCalls++;
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  });
  models.segment = async () => {
    throw new Error("SAM must be skipped for the text-only path");
  };
  models.inventory = async () => {
    throw new Error("Layout recovery must be skipped");
  };
  models.auditAndRepair = async () => {
    throw new Error("Wonder must be on demand");
  };
  models.extract = async () => {
    await models.chat("muse-spark-1.3", []);
    return normalizeQuestions([
      {
        text: "Test-only extracted text",
        sourceNumber: "1",
        correctIndex: 0,
        options: [{ text: "A" }, { text: "B" }],
      },
    ]);
  };
  const render = async (data) =>
    data.action === "normalize"
      ? { image: data.image, processing: {} }
      : {
          questions: data.questions.map((q) => ({
            imageUrl: null,
            sourceSnippet: null,
            options: q.options.map(() => null),
          })),
        };
  const paper = { questions: [], pages: [] };
  const input = {
    image: "data:image/png;base64,AA==",
    pageId: "source-1",
    sourcePage: 90,
    textOnly: true,
  };
  await digitizePage(paper, input, models, render);
  assert.equal(networkCalls, 1);
  assert.equal(paper.pages[0].modelUsage.max, 1);
  assert.equal(paper.pages[0].route, "TEXT_SPARK_ONLY");
  assert.equal(paper.questions[0].audit.status, "NOT_REQUESTED");
  await digitizePage(paper, input, models, render);
  assert.equal(networkCalls, 1, "repeat page ID reuses persisted extraction");
  paper.pages.push({ id: "2" }, { id: "3" });
  await assert.rejects(
    () => digitizePage(paper, { ...input, pageId: "4" }, models, render),
    /three selected pages/,
  );
  assert.equal(networkCalls, 1, "fourth page is rejected before any inference");
});

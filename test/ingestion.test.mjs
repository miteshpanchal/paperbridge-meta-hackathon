import { test } from "node:test";
import assert from "node:assert/strict";
import { MetaModels } from "../server/models.mjs";
import { digitizePage, auditOne, recoverOne } from "../server/ingestion.mjs";
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

test("folded unnumbered waveform questions are recovered by source position without inventing a number", async () => {
  const make = (extra = {}) => normalizeQuestions([{ text: "Waveform question", options: [{ text: "(1)" }, { text: "(2)" }], ...extra }])[0];
  const region = { sourceNumber: null, box: [100, 200, 500, 600], hasGraphicalOptions: true, complete: true };
  let extractions = 0;
  const models = {
    segment: async () => [],
    inventory: async () => [region, { sourceNumber: "14", box: [550, 200, 950, 800], complete: false, notes: "Options hidden by fold" }],
    extract: async () => {
      extractions++;
      if (extractions === 1) return [make({ sourceNumber: "14", sourceBox: [550, 200, 950, 800] })];
      const q = make({ sourceNumber: "99", sourceBox: [0, 0, 1000, 1000] });
      q.options.forEach((o) => { o.imageBox = [50, 50, 400, 400]; });
      return [q];
    },
    auditAndRepair: async () => { throw new Error("Incomplete source must not be audited"); },
  };
  const render = async (data) => data.action === "normalize" ? { image: data.image, processing: {} }
    : data.action === "regions" ? { images: ["cropped-source"] }
    : { questions: data.questions.map((q) => ({ imageUrl: null, sourceSnippet: "source", options: q.options.map((o) => o.imageBox ? "original-graph" : null) })) };
  const paper = { questions: [], pages: [] };
  await digitizePage(paper, { image: "data:image/png;base64,AA==" }, models, render);
  assert.equal(extractions, 2);
  assert.equal(paper.questions.length, 2);
  const graphical = paper.questions.find((q) => q.sourceNumber === null);
  assert.ok(graphical.options.every((o) => o.imageUrl === "original-graph"));
  assert.ok(graphical.sourceBox[3] > region.box[3], "Recovery includes context below the estimated layout boundary");
  assert.equal(paper.pages[0].coverage.recoveredQuestions, 1);
  const partial = paper.questions.find((q) => q.sourceNumber === "14");
  await auditOne(paper, { questionId: partial.id }, models);
  assert.equal(partial.audit.status, "NEEDS_REVIEW");
  await assert.rejects(() => recoverOne(paper, { pageIndex: 0 }, models, render), /No additional/);
});

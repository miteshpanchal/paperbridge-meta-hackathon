import { randomUUID } from "node:crypto";
import { fail } from "./domain.mjs";

const deferred = () => ({
  status: "NOT_REQUESTED",
  proof:
    "Independent verification has not been requested. Verify this question explicitly; the audit is capped at two model requests.",
});
async function budget(models, max, operation) {
  return models.withBudget
    ? models.withBudget(max, operation)
    : { value: await operation(), usage: { max, used: 0, models: {} } };
}
function remap(box, parent) {
  return !box
    ? null
    : [
        parent[0] + (box[0] / 1000) * (parent[2] - parent[0]),
        parent[1] + (box[1] / 1000) * (parent[3] - parent[1]),
        parent[0] + (box[2] / 1000) * (parent[2] - parent[0]),
        parent[1] + (box[3] / 1000) * (parent[3] - parent[1]),
      ];
}
function regionQuestion(region, questions) {
  const numbered = region.sourceNumber && questions.find((q) => q.sourceNumber === region.sourceNumber);
  if (numbered) return numbered;
  return questions.find((q) => {
    if (!Array.isArray(q.sourceBox)) return false;
    const cx = (q.sourceBox[0] + q.sourceBox[2]) / 2;
    const cy = (q.sourceBox[1] + q.sourceBox[3]) / 2;
    return cx >= region.box[0] && cx <= region.box[2] && cy >= region.box[1] && cy <= region.box[3];
  });
}
function targetRegion(regions, questions) {
  return regions
    .slice()
    .sort(
      (a, b) => Number(b.hasGraphicalOptions) - Number(a.hasGraphicalOptions),
    )
    .find(
      (region) => {
        const q = regionQuestion(region, questions);
        return region.complete !== false && (!q ||
          (region.hasGraphicalOptions && !q.options.some((o) => o.imageBox)));
      },
    );
}
async function recoverRegion(
  region,
  image,
  questions,
  models,
  render,
  subject,
) {
  // Layout boxes are estimates. Keep context below graphical choices so a tight
  // predicted boundary cannot silently clip the last waveform.
  const cropBox = [
    Math.max(0, region.box[0] - 20),
    Math.max(0, region.box[1] - 20),
    Math.min(1000, region.box[2] + 20),
    Math.min(1000, region.box[3] + Math.max(30, (region.box[3] - region.box[1]) * 0.35)),
  ];
  const cropped = (
    await render({ action: "regions", image, regions: [cropBox] })
  ).images[0];
  if (!cropped)
    throw fail(422, "The detected question region could not be cropped.");
  const found = await models.extract(
    cropped,
    [],
    subject,
    "This is a close view of one question. Printed number: " +
      (region.sourceNumber || "unreadable; use null rather than inventing a number") +
      ". Return exactly the central complete question, ignoring neighboring partial questions included as context. Preserve graph-only answer choices as source-image crops. Include every visible option, especially the bottom-most waveform. Do not cut off axes, labels or lower half-cycles.",
  );
  const result = region.sourceNumber
    ? found.find((q) => q.sourceNumber === region.sourceNumber)
    : found.length === 1 ? found[0] : null;
  if (!result)
    throw fail(
      422,
      "The close-up did not yield a matching printed question. Review the source; no substitute was added.",
    );
  result.sourceBox = remap(result.sourceBox, cropBox) || region.box;
  result.diagramBox = remap(result.diagramBox, cropBox);
  result.options.forEach((o) => {
    o.imageBox = remap(o.imageBox, cropBox);
  });
  const existing = regionQuestion(region, questions);
  const index = existing ? questions.indexOf(existing) : -1;
  if (!region.sourceNumber) result.sourceNumber = null;
  result.sourceComplete = region.complete !== false;
  if (index >= 0) questions[index] = result;
  else questions.push(result);
}
async function attachMedia(questions, image, render, page, sourcePage) {
  const cropped = (await render({ action: "crop", image, questions }))
    .questions;
  return questions.map((q, i) => ({
    ...q,
    imageUrl: cropped[i].imageUrl,
    sourceSnippet: cropped[i].sourceSnippet,
    options: q.options.map((o, j) => ({
      ...o,
      imageUrl: cropped[i].options[j],
    })),
    page,
    sourcePage,
    audit:
      q.audit?.status && q.audit.status !== "PENDING" ? q.audit : deferred(),
  }));
}

export async function digitizePage(current, input, models, render) {
  if (input.pageId && current.pages.some((p) => p.id === input.pageId)) return;
  if (current.pages.length >= 3)
    throw fail(
      422,
      "The judge workspace processes at most three selected pages per paper.",
    );
  if (
    typeof input.image !== "string" ||
    !/^data:image\/(png|jpeg|webp);base64,/.test(input.image)
  )
    throw fail(
      422,
      "Upload a supported image or a selected rasterized PDF page.",
    );
  const { image, processing } = await render({
    action: "normalize",
    image: input.image,
    cleanScan: input.cleanScan === true,
  });
  const textOnly = input.textOnly === true;
  const focused = !textOnly && input.recoverLayout !== false;
  const execution = await budget(
    models,
    textOnly ? 1 : focused ? 4 : 2,
    async () => {
      const boxes = textOnly ? [] : await models.segment(image, ["diagram"]);
      let questions = await models.extract(
        image,
        boxes,
        String(input.subject || "General").slice(0, 100),
        String(input.nativeText || ""),
      );
      let regions = [],
        recovered = 0,
        recoveryNote = "";
      if (focused && models.inventory) {
        regions = await models.inventory(image);
        const region = targetRegion(regions, questions);
        if (region) {
          try {
            await recoverRegion(
              region,
              image,
              questions,
              models,
              render,
              String(input.subject || "General"),
            );
            recovered = 1;
          } catch (e) {
            recoveryNote = e.message;
          }
        }
      }
      return { boxes, questions, regions, recovered, recoveryNote };
    },
  );
  const { boxes, regions, recovered, recoveryNote } = execution.value;
  let { questions } = execution.value;
  for (const region of regions.filter((r) => r.complete === false)) {
    const q = regionQuestion(region, questions);
    if (q) {
      q.sourceComplete = false;
      q.audit = { status: "NEEDS_REVIEW", proof: "The source layout is incomplete: " + String(region.notes || "Part of this question or its choices is obscured.") };
    }
  }
  if (current.questions.length + questions.length > 200)
    throw fail(422, "Limit: 200 single-correct questions per paper.");
  questions.sort(
    (a, b) => Number(a.sourceNumber || 9999) - Number(b.sourceNumber || 9999),
  );
  const page = current.pages.length + 1,
    sourcePage = input.sourcePage || page;
  questions = await attachMedia(questions, image, render, page, sourcePage);
  current.pages.push({
    id: input.pageId || randomUUID(),
    image,
    rawImage: input.image,
    processing,
    sourcePage,
    filename: String(input.filename || "").slice(0, 200),
    boxes,
    layoutRegions: regions,
    modelUsage: execution.usage,
    route: textOnly
      ? "TEXT_SPARK_ONLY"
      : focused
        ? "VISUAL_FOCUSED"
        : "VISUAL_ECONOMY",
    coverage: {
      inventoriedRegions: regions.length,
      recoveredQuestions: recovered,
      missingNumbers: regions
        .filter(
          (r) =>
            r.sourceNumber &&
            !questions.some((q) => q.sourceNumber === r.sourceNumber),
        )
        .map((r) => r.sourceNumber),
      missingRegions: regions.filter((r) => !regionQuestion(r, questions)).map((r) => ({ sourceNumber: r.sourceNumber, box: r.box, notes: r.notes })),
      note: recoveryNote,
    },
    questionCount: questions.length,
  });
  current.questions.push(...questions);
}

export async function recoverOne(current, input, models, render) {
  const index = Number(input.pageIndex),
    page = current.pages[index];
  if (!page) throw fail(422, "Select a processed source page.");
  let regions = page.layoutRegions || [];
  const existing = current.questions.filter((q) => q.page === index + 1);
  if (input.box) {
    const box = input.box;
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      box.some((v) => typeof v !== "number" || v < 0 || v > 1000) ||
      box[2] <= box[0] ||
      box[3] <= box[1]
    )
      throw fail(422, "Choose a valid source region.");
    const execution = await budget(models, 1, async () => {
      const image = (
        await render({ action: "regions", image: page.image, regions: [box] })
      ).images[0];
      const found = await models.extract(
        image,
        [],
        "General",
        "Operator-selected source region. Printed question number, if supplied by operator: " +
          String(input.sourceNumber || "unknown"),
      );
      if (found.length !== 1)
        throw fail(
          422,
          "Select a tighter region around one complete question and all its options.",
        );
      const q = found[0];
      if (!q.sourceNumber && /^\d{1,4}$/.test(String(input.sourceNumber || "")))
        q.sourceNumber = String(input.sourceNumber);
      q.sourceBox = remap(q.sourceBox, box) || box;
      q.diagramBox = remap(q.diagramBox, box);
      q.options.forEach((o) => {
        o.imageBox = remap(o.imageBox, box);
      });
      const old = existing.findIndex(
        (item) => q.sourceNumber && item.sourceNumber === q.sourceNumber,
      );
      if (old >= 0) existing[old] = q;
      else existing.push(q);
    });
    const updated = await attachMedia(
      existing,
      page.image,
      render,
      index + 1,
      page.sourcePage,
    );
    current.questions = current.questions
      .filter((q) => q.page !== index + 1)
      .concat(updated)
      .sort(
        (a, b) =>
          a.page - b.page ||
          Number(a.sourceNumber || 9999) - Number(b.sourceNumber || 9999),
      );
    page.questionCount = updated.length;
    page.lastRecoveryUsage = execution.usage;
    return;
  }
  const execution = await budget(models, 2, async () => {
    if (!regions.length) regions = await models.inventory(page.image);
    const region = targetRegion(regions, existing);
    if (!region)
      throw fail(
        422,
        "No additional missing graphical/question region was identified. Use the editor to inspect source crops.",
      );
    await recoverRegion(
      region,
      page.image,
      existing,
      models,
      render,
      "General",
    );
  });
  const updated = await attachMedia(
    existing,
    page.image,
    render,
    index + 1,
    page.sourcePage,
  );
  current.questions = current.questions
    .filter((q) => q.page !== index + 1)
    .concat(updated)
    .sort(
      (a, b) =>
        a.page - b.page ||
        Number(a.sourceNumber || 9999) - Number(b.sourceNumber || 9999),
    );
  page.layoutRegions = regions;
  page.lastRecoveryUsage = execution.usage;
  page.questionCount = updated.length;
  page.coverage = {
    inventoriedRegions: regions.length,
    missingNumbers: regions
      .filter(
        (r) =>
          r.sourceNumber &&
          !updated.some((q) => q.sourceNumber === r.sourceNumber),
      )
      .map((r) => r.sourceNumber),
  };
}

export async function auditOne(current, input, models) {
  const index = current.questions.findIndex((q) => q.id === input.questionId);
  if (index < 0)
    throw fail(422, "Select one question to verify; bulk audits are disabled.");
  const q = current.questions[index],
    page = current.pages[(q.page || 1) - 1];
  if (q.sourceComplete === false) {
    q.audit = { status: "NEEDS_REVIEW", proof: "The uploaded source has obscured or incomplete content. Supply a complete source for this question before independent verification or hosting." };
    return;
  }
  if (q.audit.status === "VERIFIED") return;
  const execution = await budget(models, 2, () =>
    models.auditAndRepair(q, page.image),
  );
  current.questions[index] = {
    ...execution.value,
    lastAuditUsage: execution.usage,
  };
}

import { createHash, randomUUID } from "node:crypto";
import { fail, grade, includedQuestions } from "./domain.mjs";

export const journeyOf = (paper) => paper.journey || "organization";
export function journey(value = "organization") {
  if (!["organization", "student"].includes(value))
    throw fail(422, "Choose organization or student.");
  return value;
}
export const stableId = (text) => {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export async function workspace(store, owner, role) {
  const id = stableId(`workspace:${owner}:${journey(role)}`);
  try {
    return await store.get(id, owner);
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      await store.create({
        id,
        owner,
        kind: "WORKSPACE",
        journey: role,
        papers: [],
      });
    } catch (conflict) {
      if (conflict.status !== 409) throw conflict;
    }
    return store.get(id, owner);
  }
}
export async function registerPaper(store, paper) {
  const index = await workspace(store, paper.owner, journeyOf(paper));
  await store.update(index.id, paper.owner, async (current) => {
    if (!current.papers.includes(paper.id)) current.papers.push(paper.id);
  });
}
export async function listPapers(store, owner, role) {
  const index = await workspace(store, owner, role);
  const records = await Promise.all(
    index.papers
      .slice(-40)
      .reverse()
      .map(async (id) => {
        try {
          const p = await store.get(id, owner);
          return {
            id: p.id,
            name: p.name,
            journey: journeyOf(p),
            questionCount: p.questions.length,
            pageCount: p.pages.length,
            hosted: Boolean(p.hosted),
            analyzed: Boolean(p.originalAttempt),
            createdAt: p.createdAt,
          };
        } catch (e) {
          if (e.status === 404) return null;
          throw e;
        }
      }),
  );
  return records.filter(Boolean);
}
export function assertScope(paper, requested) {
  if (requested && journey(requested) !== journeyOf(paper))
    throw fail(404, "Paper not found in this workspace.");
}
export function confirmAnswers(paper, input) {
  if (input.confirmed !== true)
    throw fail(422, "Review and confirm your actual responses before scoring.");
  if (
    !Array.isArray(input.responseStates) ||
    input.responseStates.length !== paper.questions.length
  )
    throw fail(422, "Confirm each response or explicitly mark it skipped.");
  return input.responseStates.map((state, i) => {
    if (state === "SKIPPED") return null;
    if (state !== "SELECTED" || !Number.isInteger(input.answers?.[i]))
      throw fail(422, `Question ${i + 1} still has an unresolved response.`);
    return input.answers[i];
  });
}
export async function saveOriginalAttempt(store, current, owner, input) {
  const answers = confirmAnswers(current, input);
  if (current.originalAttempt) {
    const prior = await store.get(current.originalAttempt.id, owner);
    if (JSON.stringify(prior.answers) !== JSON.stringify(answers))
      throw fail(
        409,
        "Your original attempt is saved. Start a retry to record different answers.",
      );
    return prior.report;
  }
  const report = {
    ...grade(current, answers),
    kind: "ORIGINAL_ATTEMPT",
    scopeLabel: `${current.questions.length} digitized questions from ${current.pages.length} selected pages`,
    recordedAt: new Date().toISOString(),
  };
  const attempt = {
    id: randomUUID(),
    owner,
    kind: "ORIGINAL_ATTEMPT",
    paperId: current.id,
    answers,
    report,
  };
  await store.save(attempt);
  current.originalAttempt = {
    id: attempt.id,
    recordedAt: report.recordedAt,
    score: report.score,
    maxScore: report.maxScore,
  };
  return report;
}
export async function studentCopy(store, paper, owner) {
  if (!paper.hosted)
    throw fail(422, "Host the reviewed organization paper before sharing it.");
  const copy = {
    id: randomUUID(),
    owner,
    journey: "student",
    mode: "LIVE_UPLOAD",
    name: paper.name,
    marks: paper.marks,
    penalty: paper.penalty,
    durationMins: paper.durationMins,
    pages: structuredClone(paper.pages),
    questions: structuredClone(includedQuestions(paper)),
    sharedFrom: paper.id,
    ...(paper.evidenceOrigin
      ? { evidenceOrigin: structuredClone(paper.evidenceOrigin) }
      : {}),
    createdAt: new Date().toISOString(),
  };
  copy.questions.forEach((q) => {
    q.studentResponse = {
      selectedIndex: null,
      confidence: 0,
      evidence: "Enter the response you actually marked.",
    };
  });
  await store.save(copy);
  await registerPaper(store, copy);
  return copy;
}

export async function evidenceCopy(store, source, pageIndex, owner, role) {
  const page = source.pages[pageIndex];
  const questions = source.questions.filter((q) => q.page === pageIndex + 1);
  if (source.mode !== "LIVE_UPLOAD" || !page || !questions.length)
    throw fail(422, "The saved uploaded-page evidence is unavailable.");
  const copy = {
    id: randomUUID(),
    owner,
    journey: journey(role),
    mode: "LIVE_UPLOAD",
    name: "Folded-paper example · your private copy",
    marks: source.marks,
    penalty: source.penalty,
    durationMins: source.durationMins,
    pages: structuredClone([page]),
    questions: structuredClone(questions),
    evidenceOrigin: {
      kind: "SAVED_LIVE_EXTRACTION",
      sourcePage: page.sourcePage,
      capturedAt: source.createdAt,
    },
    createdAt: new Date().toISOString(),
  };
  copy.questions.forEach((q) => {
    q.id = randomUUID();
    q.page = 1;
    q.studentResponse = {
      selectedIndex: null,
      confidence: 0,
      evidence: "Enter your own response for this example.",
    };
  });
  await store.create(copy);
  await registerPaper(store, copy);
  return copy;
}

import { randomUUID } from "node:crypto";

export const fail = (status, message) =>
  Object.assign(new Error(message), { status });

export function normalizeQuestions(input, keySource = "AI_ESTIMATE") {
  if (!Array.isArray(input) || input.length < 1 || input.length > 200)
    throw fail(
      422,
      "No supported questions extracted (limit: 200 single-correct questions).",
    );
  return input.map((q, index) => {
    if (q.type && q.type !== "SINGLE_CORRECT")
      throw fail(
        422,
        `Question ${index + 1}: this release supports single-correct MCQs. Split out numerical/multiple-correct questions.`,
      );
    if (
      typeof q.text !== "string" ||
      !q.text.trim() ||
      q.text.length > 50000 ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 6
    )
      throw fail(422, `Question ${index + 1} has incomplete text or options.`);
    const detectedCorrect = Number.isInteger(q.correctIndex)
      ? q.correctIndex
      : q.options.findIndex((o) => o.isCorrect === true);
    const correct =
      detectedCorrect >= 0 && detectedCorrect < q.options.length
        ? detectedCorrect
        : null;
    return {
      id: randomUUID(),
      text: q.text.trim(),
      type: "SINGLE_CORRECT",
      subject: String(q.subject || q.subjectName || "General").slice(0, 100),
      topic: String(q.topic || q.topicName || "Unclassified").slice(0, 150),
      correctIndex: correct,
      sourceNumber: /^\d{1,4}$/.test(String(q.sourceNumber || ""))
        ? String(q.sourceNumber)
        : null,
      sourceBox: q.sourceBox || null,
      studentResponse: {
        selectedIndex:
          Number.isInteger(q.studentResponse?.selectedIndex) &&
          q.studentResponse.selectedIndex >= 0 &&
          q.studentResponse.selectedIndex < q.options.length
            ? q.studentResponse.selectedIndex
            : null,
        confidence:
          typeof q.studentResponse?.confidence === "number"
            ? q.studentResponse.confidence
            : 0,
        evidence: String(
          q.studentResponse?.evidence || "No unambiguous response detected.",
        ).slice(0, 1000),
      },
      keySource,
      explanation: String(q.explanation || "").slice(0, 50000),
      diagramBox: q.diagramBox || null,
      options: q.options.map((o) => ({
        text: String(o.text || "").slice(0, 5000),
        misconception: String(
          o.misconception || o.misconceptionTag || "",
        ).slice(0, 2000),
        imageBox: o.imageBox || null,
        imageAlt: String(o.imageAlt || "").slice(0, 1000),
      })),
      audit: { status: "PENDING", proof: "" },
    };
  });
}

export function validateAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw fail(422, "Send one answer per question; use null for unattempted.");
  answers.forEach((a, i) => {
    if (
      a !== null &&
      (!Number.isInteger(a) || a < 0 || a >= questions[i].options.length)
    )
      throw fail(422, `Invalid answer for question ${i + 1}.`);
  });
}

export function grade(paper, answers) {
  if (paper.questions.some((q) => !Number.isInteger(q.correctIndex)))
    throw fail(
      422,
      "Some questions have no answer key yet. Supply or edit the key before calculating marks.",
    );
  validateAnswers(paper.questions, answers);
  const topics = new Map();
  const review = paper.questions.map((q, index) => {
    const answer = answers[index];
    const status =
      answer === null
        ? "UNATTEMPTED"
        : answer === q.correctIndex
          ? "CORRECT"
          : "INCORRECT";
    const marks =
      status === "CORRECT"
        ? paper.marks
        : status === "INCORRECT"
          ? -paper.penalty
          : 0;
    const topic = topics.get(q.topic) || {
      topic: q.topic,
      total: 0,
      correct: 0,
      lostMarks: 0,
    };
    topic.total++;
    topic.correct += status === "CORRECT" ? 1 : 0;
    topic.lostMarks += paper.marks - marks;
    topics.set(q.topic, topic);
    return {
      ...q,
      answer,
      status,
      marks,
      misconception:
        status === "INCORRECT"
          ? q.options[answer].misconception ||
            "Review the reasoning behind this choice with your coach."
          : null,
    };
  });
  return {
    score: review.reduce((sum, q) => sum + q.marks, 0),
    maxScore: paper.questions.length * paper.marks,
    correct: review.filter((q) => q.status === "CORRECT").length,
    incorrect: review.filter((q) => q.status === "INCORRECT").length,
    unattempted: review.filter((q) => q.status === "UNATTEMPTED").length,
    keyLabel: paper.questions.every((q) => q.keySource === "PROVIDED_KEY")
      ? "Scored against your supplied answer key"
      : "Estimated score against AI-derived or edited answers; compare with the official key",
    topics: [...topics.values()].sort((a, b) => b.lostMarks - a.lostMarks),
    review,
  };
}

export function publicPaper(paper) {
  return {
    id: paper.id,
    name: paper.name,
    marks: paper.marks,
    penalty: paper.penalty,
    durationMins: paper.durationMins,
    mode: paper.mode,
    questions: paper.questions.map((q) => ({
      id: q.id,
      text: q.text,
      imageUrl: q.imageUrl,
      subject: q.subject,
      options: q.options.map((o) => ({ text: o.text, imageUrl: o.imageUrl })),
    })),
  };
}

export function canPublish(paper) {
  return (
    paper.questions.length > 0 &&
    paper.questions.every((q) => q.audit.status === "VERIFIED")
  );
}

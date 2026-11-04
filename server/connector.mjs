import { fail } from "./domain.mjs";

export class ClarifyCueConnector {
  constructor(config = process.env, transport = fetch) {
    this.base = (config.CLARIFYCUE_API_URL || "").replace(/\/$/, "");
    this.key = config.CLARIFYCUE_PAPER_API_KEY;
    this.examId = config.CLARIFYCUE_EXAM_ID;
    this.transport = transport;
  }
  get configured() {
    return Boolean(this.base && this.key && this.examId);
  }
  async request(path, body) {
    if (!this.configured)
      throw fail(
        503,
        "ClarifyCue connector is not configured. Hosting in PaperBridge remains available.",
      );
    const url = new URL(this.base + path);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw fail(503, "Use HTTPS for a remote platform connector.");
    let response;
    try {
      response = await this.transport(url, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      throw fail(
        502,
        "ClarifyCue could not be reached. Retry safely with the same paper.",
      );
    }
    if (!response.ok)
      throw fail(
        502,
        `ClarifyCue returned HTTP ${response.status}. No success receipt was recorded.`,
      );
    return response.json();
  }
  payload(paper) {
    const image = (text, url) =>
      url ? `${text}\n\n![Option diagram](${url})` : text;
    return {
      externalId: paper.id,
      name: paper.name,
      description:
        "Digitized from an uploaded paper using PaperBridge. Confirm AI-derived keys against the official published key.",
      examId: this.examId,
      durationMins: paper.durationMins,
      marksPerQuestion: paper.marks,
      negativeMarking: paper.penalty > 0,
      questions: paper.questions.map((q) => ({
        text: q.text,
        imageUrl: q.imageUrl || undefined,
        explanation: q.explanation,
        options: q.options.map((o, i) => ({
          text: image(o.text, o.imageUrl),
          isCorrect: i === q.correctIndex,
        })),
      })),
    };
  }
  async publish(paper) {
    const receipt = await this.request(
      "/integrations/papers",
      this.payload(paper),
    );
    if (
      typeof receipt.testId !== "string" ||
      receipt.isPublished !== true ||
      receipt.questionCount !== paper.questions.length
    )
      throw fail(502, "ClarifyCue returned an incomplete publication receipt.");
    const confirmed = await this.request(
      `/integrations/papers/${encodeURIComponent(receipt.testId)}`,
    );
    if (
      confirmed.testId !== receipt.testId ||
      confirmed.isPublished !== true ||
      confirmed.questionCount !== paper.questions.length ||
      confirmed.externalId !== paper.id
    )
      throw fail(
        502,
        "Read-back verification failed. Retry to verify the existing publication.",
      );
    return {
      ...confirmed,
      reused: Boolean(receipt.reused),
      readBackVerifiedAt: new Date().toISOString(),
    };
  }
}

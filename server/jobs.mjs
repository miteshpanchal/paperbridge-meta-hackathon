import { createHash } from "node:crypto";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import { stableId } from "./workspaces.mjs";
import { fail } from "./domain.mjs";

const allowed = new Set([
  "pages",
  "recover",
  "audit",
  "responses",
  "coach",
  "voice",
]);
export class Jobs {
  constructor(store, config, execute, transport = fetch) {
    this.store = store;
    this.config = config;
    this.execute = execute;
    this.transport = transport;
    this.auth = new OAuth2Client();
    this.credentials = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    if (config.K_SERVICE && !config.TASKS_QUEUE)
      throw new Error(
        "Cloud Run requires TASKS_QUEUE for durable inference processing.",
      );
    if (
      config.TASKS_QUEUE &&
      (!config.DATA_BUCKET ||
        !config.WORKER_URL ||
        !config.TASKS_SERVICE_ACCOUNT)
    )
      throw new Error(
        "Cloud Tasks requires private DATA_BUCKET, WORKER_URL and TASKS_SERVICE_ACCOUNT.",
      );
  }
  public(job) {
    return {
      id: job.id,
      paperId: job.paperId,
      action: job.action,
      journey: job.journey,
      questionId: job.questionId,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      result: job.result || null,
      error: job.error || null,
    };
  }
  async enqueue(owner, paper, action, input, requestId) {
    if (!allowed.has(action))
      throw fail(422, "Choose a supported processing action.");
    if (
      typeof requestId !== "string" ||
      !/^[-a-zA-Z0-9]{8,80}$/.test(requestId)
    )
      throw fail(422, "A stable operation ID is required.");
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ action, input }))
      .digest("hex");
    const id = stableId(`job:${owner}:${paper.id}:${requestId}`);
    let existing;
    try {
      existing = await this.store.get(id, owner);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    if (existing) {
      if (existing.inputHash !== inputHash)
        throw fail(409, "This operation ID already refers to different input.");
      return this.public(existing);
    }
    const job = {
      id,
      owner,
      kind: "PROCESSING_JOB",
      paperId: paper.id,
      journey: paper.journey || "organization",
      action,
      questionId: input.questionId || null,
      input,
      inputHash,
      status: "QUEUED",
      stage: "Waiting for a worker",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.store.create(job);
    } catch (e) {
      if (e.status !== 409) throw e;
      return this.public(await this.store.get(id, owner));
    }
    try {
      await this.store.update(paper.id, owner, async (current) => {
        if (current.activeJob && current.activeJob.id !== id)
          throw fail(
            409,
            "This paper already has a processing job. Resume it before starting another action.",
          );
        current.activeJob = { id, createdAt: job.createdAt };
      });
    } catch (e) {
      await this.store.update(id, owner, async (d) => {
        d.status = "FAILED";
        d.error = { status: e.status || 409, message: e.message };
        delete d.input;
      });
      throw e;
    }
    if (this.config.TASKS_QUEUE) {
      try {
        await this.dispatch(id);
      } catch (e) {
        await this.store.update(id, owner, async (d) => {
          d.status = "FAILED";
          d.stage = "Queue delivery failed before inference";
          d.error = {
            message:
              "The processing queue is unavailable. No worker was started.",
            status: 503,
          };
        });
        await this.unlock(job);
        throw e;
      }
    } else {
      // Local development only. Cloud Run is required to use Cloud Tasks above.
      setImmediate(() =>
        this.run(id).catch((error) =>
          console.error("Local job failed", error.message),
        ),
      );
    }
    return this.public(job);
  }
  async dispatch(id) {
    const client = await this.credentials.getClient();
    const access = await client.getAccessToken();
    const response = await this.transport(
      `https://cloudtasks.googleapis.com/v2/${this.config.TASKS_QUEUE}/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + access.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: {
            name: `${this.config.TASKS_QUEUE}/tasks/paperbridge-${id}`,
            dispatchDeadline: "900s",
            httpRequest: {
              httpMethod: "POST",
              url:
                this.config.WORKER_URL.replace(/\/$/, "") +
                "/api/internal/jobs/" +
                id +
                "/run",
              headers: { "Content-Type": "application/json" },
              body: Buffer.from("{}").toString("base64"),
              oidcToken: {
                serviceAccountEmail: this.config.TASKS_SERVICE_ACCOUNT,
                audience: this.config.WORKER_URL.replace(/\/$/, ""),
              },
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok && response.status !== 409)
      throw fail(503, "The processing task could not be queued.");
  }
  async verify(authorization) {
    if (!this.config.TASKS_QUEUE)
      throw fail(404, "Worker delivery is not enabled.");
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) throw fail(401, "Worker identity is required.");
    try {
      const ticket = await this.auth.verifyIdToken({
        idToken: token,
        audience: this.config.WORKER_URL.replace(/\/$/, ""),
      });
      const p = ticket.getPayload();
      if (
        p.email !== this.config.TASKS_SERVICE_ACCOUNT ||
        p.email_verified !== true
      )
        throw new Error("Wrong worker identity");
    } catch {
      throw fail(403, "Worker identity could not be verified.");
    }
  }
  async run(id) {
    let claimed = false;
    await this.store.update(id, null, async (job) => {
      if (job.status !== "QUEUED") return;
      job.status = "RUNNING";
      job.startedAt = Date.now();
      job.updatedAt = new Date().toISOString();
      job.stage = "Processing the chosen input within its model allowance";
      claimed = true;
    });
    if (!claimed) return;
    const job = await this.store.get(id);
    try {
      const result = await this.execute(job);
      await this.unlock(job);
      await this.store.update(id, null, async (d) => {
        d.status = "SUCCEEDED";
        d.stage = "Saved";
        d.result = result;
        d.updatedAt = new Date().toISOString();
        delete d.input;
      });
    } catch (e) {
      await this.unlock(job);
      await this.store.update(id, null, async (d) => {
        d.status = "FAILED";
        d.stage = "Stopped; no automatic inference retry";
        d.error = {
          message: e.status
            ? e.message
            : "The job stopped unexpectedly. Review the source before retrying.",
          status: e.status || 500,
        };
        d.updatedAt = new Date().toISOString();
        delete d.input;
      });
    }
  }
  async unlock(job) {
    if (!job.paperId) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.store.update(job.paperId, job.owner, async (p) => {
          if (p.activeJob?.id === job.id) delete p.activeJob;
        });
        return;
      } catch (e) {
        if (e.status === 404) return;
        if (e.status !== 409 || attempt >= 4) throw e;
      }
    }
  }
  async get(id, owner) {
    const job = await this.store.get(id, owner);
    if (job.kind !== "PROCESSING_JOB")
      throw fail(404, "Processing job not found.");
    if (
      ["QUEUED", "RUNNING"].includes(job.status) &&
      Date.now() - (job.startedAt || Date.parse(job.createdAt)) > 16 * 60000
    )
      await this.store.update(id, owner, async (d) => {
        if (!["QUEUED", "RUNNING"].includes(d.status)) return;
        d.status = "INTERRUPTED";
        d.stage =
          "Worker interrupted; inference was not automatically repeated";
        d.updatedAt = new Date().toISOString();
        delete d.input;
      });
    const current = await this.store.get(id, owner);
    if (current.status === "INTERRUPTED") await this.unlock(current);
    return this.public(current);
  }
}

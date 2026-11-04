import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname, sep } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  createHmac,
  createHash,
  randomUUID,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { MetaModels } from "./models.mjs";
import { Store } from "./store.mjs";
import { CloudStore } from "./cloud-store.mjs";
import {
  fail,
  grade,
  canPublish,
  publicPaper,
  normalizeQuestions,
  includedQuestions,
} from "./domain.mjs";
import { ClarifyCueConnector } from "./connector.mjs";
import { digitizePage, recoverOne, auditOne } from "./ingestion.mjs";
import { Allowance } from "./allowance.mjs";
import { Jobs } from "./jobs.mjs";
import {
  journey,
  journeyOf,
  assertScope,
  registerPaper,
  listPapers,
  saveOriginalAttempt,
  studentCopy,
  evidenceCopy,
} from "./workspaces.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const katexDir = resolve(
  dirname(createRequire(import.meta.url).resolve("katex")),
);
const pdfjsDir = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const same = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
};

export async function media(data, config) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      config.PYTHON || "python",
      [resolve(root, "server/media.py")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(fail(504, "PDF/image processing timed out."));
    }, 60000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024 * 1024) {
        child.kill();
        reject(fail(413, "Rendered paper is too large."));
      }
    });
    child.stderr.on("data", (chunk) => {
      error += chunk.toString().slice(0, 500);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        fail(
          503,
          "Python is not available. Install the documented media dependencies.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output);
        if (code || value.error) {
          reject(fail(422, value.error || "Could not process this PDF/image. Check file format, size, and page limit."));
          return;
        }
        resolvePromise(value);
      } catch {
        reject(
          fail(
            422,
            error.includes("ModuleNotFoundError")
              ? "Install the Python media dependencies from requirements.txt."
              : "Could not process this PDF/image. Check file format, size, and page limit.",
          ),
        );
      }
    });
    child.stdin.on("error", () => { });
    child.stdin.end(JSON.stringify(data));
  });
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 36 * 1024 * 1024)
      throw fail(413, "Upload limit is 25 MB before encoding.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw fail(400, "Invalid JSON.");
  }
}

export function createApp(config = process.env, dependencies = {}) {
  if (
    !config.JUDGE_EMAIL ||
    !config.JUDGE_PASSWORD ||
    config.JUDGE_PASSWORD.length < 12 ||
    !config.SESSION_SECRET ||
    config.SESSION_SECRET.length < 32
  )
    throw new Error(
      "Run npm run setup or set JUDGE_EMAIL, JUDGE_PASSWORD (12+ chars), SESSION_SECRET (32+ chars).",
    );
  const store =
    dependencies.store ||
    (config.DATA_BUCKET
      ? new CloudStore(config.DATA_BUCKET)
      : new Store(config.DATA_DIR || resolve(root, ".data")));
  const allowance = dependencies.allowance || new Allowance(store, config);
  const models =
    dependencies.models || new MetaModels(config, fetch, allowance);
  const connector = dependencies.connector || new ClarifyCueConnector(config);
  const renderMedia = dependencies.media || ((data) => media(data, config));
  let mediaTail = Promise.resolve();
  // Bound Python memory usage when several judges request exports or previews.
  const render = (data) => {
    const result = mediaTail.then(() => renderMedia(data));
    mediaTail = result.catch(() => { });
    return result;
  };

  const runAs = (owner, operation) =>
    models.withActor ? models.withActor(owner, operation) : operation();
  async function mutatePaper(current, action, input, owner, jobId) {
    if (current.activeJob && current.activeJob.id !== jobId)
      throw fail(
        409,
        "This paper is being processed. Resume its job before changing the paper.",
      );
    const id = current.id,
      session = { owner };
    return runAs(owner, async () => {
      if (
        [
          "pages",
          "recover",
          "audit",
          "edit",
          "key",
          "settings",
          "selection",
        ].includes(action) &&
        (current.hosted || current.publication || current.originalAttempt)
      )
        throw fail(
          409,
          "This paper has a published test or saved original attempt. Create a new paper to change its content.",
        );
      if (action === "pages") {
        await digitizePage(current, input, models, render);
      } else if (action === "recover") {
        await recoverOne(current, input, models, render);
      } else if (action === "audit") {
        await auditOne(current, input, models);
      } else if (action === "edit") {
        const index = current.questions.findIndex(
          (q) => q.id === input.questionId,
        );
        if (index < 0) throw fail(404, "Question not found.");
        const existing = current.questions[index];
        const edited = normalizeQuestions(
          [{ ...existing, ...input.question, type: "SINGLE_CORRECT" }],
          "MANUAL_EDIT",
        )[0];
        const page = current.pages[(existing.page || 1) - 1];
        const cropped = (
          await render({
            action: "crop",
            image: page.image,
            questions: [edited],
          })
        ).questions[0];
        current.questions[index] = {
          ...existing,
          ...edited,
          id: existing.id,
          imageUrl: cropped.imageUrl,
          sourceSnippet: cropped.sourceSnippet,
          options: edited.options.map((o, i) => ({
            ...o,
            imageUrl: cropped.options[i],
          })),
          audit: {
            status: "NEEDS_REVIEW",
            proof:
              "Content was edited. Run a fresh audit before hosting or publishing.",
          },
        };
      } else if (action === "responses") {
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(input.image || ""))
          throw fail(
            422,
            "Upload an OMR/response image or a rasterized PDF page.",
          );
        const { image } = await render({
          action: "normalize",
          image: input.image,
          cleanScan: input.cleanScan === true,
        });
        const detections = await models.readResponses(image, current.questions);
        current.responseDetections = detections
          .filter((row) =>
            current.questions.some(
              (q) => q.sourceNumber === String(row.questionNumber),
            ),
          )
          .map((row) => {
            const q = current.questions.find(
              (q) => q.sourceNumber === String(row.questionNumber),
            );
            const valid =
              Number.isInteger(row.selectedIndex) &&
              row.selectedIndex >= 0 &&
              row.selectedIndex < q.options.length &&
              row.ambiguous !== true &&
              row.confidence >= 0.9;
            return {
              questionId: q.id,
              questionNumber: String(row.questionNumber),
              selectedIndex: valid ? row.selectedIndex : null,
              confidence: Number(row.confidence) || 0,
              evidence: String(row.evidence || "").slice(0, 1000),
              needsConfirmation: true,
            };
          });
      } else if (action === "key") {
        const key = input.answers;
        if (
          !Array.isArray(key) ||
          key.length !== current.questions.length ||
          key.some(
            (v, i) =>
              !Number.isInteger(v) ||
              v < 0 ||
              v >= current.questions[i].options.length,
          )
        )
          throw fail(422, "Supply one valid answer index for every question.");
        current.questions.forEach((q, i) => {
          if (q.correctIndex !== key[i])
            q.audit = {
              status: "NEEDS_REVIEW",
              proof:
                "Your supplied key differs from the AI key. Resolve this disagreement before publication.",
            };
          q.correctIndex = key[i];
          q.keySource = "PROVIDED_KEY";
        });
      } else if (action === "settings") {
        if (
          ![1, 2, 4].includes(input.marks) ||
          ![0, 0.25, 0.5, 1].includes(input.penalty) ||
          !Number.isInteger(input.durationMins) ||
          input.durationMins < 1 ||
          input.durationMins > 360
        )
          throw fail(422, "Invalid marking scheme or duration.");
        current.marks = input.marks;
        current.penalty = input.penalty;
        current.durationMins = input.durationMins;
        current.name = String(input.name || current.name)
          .trim()
          .slice(0, 200);
      } else if (action === "selection") {
        const ids = input.questionIds;
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !current.questions.some((q) => q.id === id))
        )
          throw fail(
            422,
            "Choose at least one existing question for the hosted test.",
          );
        current.selectedQuestionIds = ids;
      } else if (action === "analyze") {
        return saveOriginalAttempt(store, current, session.owner, input);
      } else if (action === "host") {
        if (!canPublish(current))
          throw fail(
            422,
            "All questions need a complete agreeing audit before hosting.",
          );
        current.hosted = true;
        if (!decode(current.hostToken || ""))
          current.hostToken = encode({
            paperId: id,
            kind: "host",
            exp: Date.now() + 7 * 86400000,
          });
      } else if (action === "publish") {
        if (!canPublish(current))
          throw fail(
            422,
            "Resolve incomplete or disagreeing audits before publishing.",
          );
        // ClarifyCue currently uses a fixed 25% penalty ratio in its standard runner.
        if (current.penalty !== 0 && current.penalty !== current.marks / 4)
          throw fail(
            422,
            "ClarifyCue supports a penalty of 25% of question marks. Choose +4/-1 or disable negative marking.",
          );
        current.publication = await connector.publish({
          ...current,
          questions: includedQuestions(current),
        });
      } else throw fail(404, "Action not found.");
      return current;
    });
  }
  async function executeJob(job) {
    const work = async () => {
      const paper = await store.get(job.paperId, job.owner);
      assertScope(paper, job.journey);
      if (
        ["responses", "coach", "voice"].includes(job.action) &&
        journeyOf(paper) !== "student"
      )
        throw fail(403, "This action belongs to the student workspace.");
      if (["pages", "recover", "audit", "responses"].includes(job.action)) {
        await store.update(paper.id, job.owner, (current) =>
          mutatePaper(current, job.action, job.input, job.owner, job.id),
        );
        return { paperId: paper.id };
      }
      if (job.action === "voice")
        return models.transcribe(String(job.input.audioBase64 || ""));
      const question = paper.questions.find(
        (q) => q.id === job.input.questionId,
      ),
        doubt = String(job.input.doubt || "").slice(0, 4000);
      if (!question || !doubt.trim())
        throw fail(422, "Choose a question and enter your doubt.");
      return models.coach(
        question,
        doubt,
        Array.isArray(job.input.history) ? job.input.history : [],
      );
    };
    const notify = (model) =>
      store.update(job.id, null, async (j) => {
        j.stage = "Preparing " + model + " · checking its allowance";
        j.updatedAt = new Date().toISOString();
      });
    return models.withActor
      ? models.withActor(job.owner, work, notify)
      : work();
  }

  const jobs = dependencies.jobs || new Jobs(store, config, executeJob);
  const attempts = new Map();
  let showcaseCache = null;
  let showcasePending = null;
  const showcaseDescriptor = "00000000-0000-0000-0000-000000000001";
  const basePath = (config.BASE_PATH || "").replace(/\/$/, "");
  if (basePath && !/^\/[a-zA-Z0-9/-]+$/.test(basePath))
    throw new Error(
      "BASE_PATH must be an absolute URL path such as /hackathon.",
    );
  const sign = (data) =>
    createHmac("sha256", config.SESSION_SECRET)
      .update(data)
      .digest("base64url");
  const encode = (value) => {
    const data = Buffer.from(JSON.stringify(value)).toString("base64url");
    return data + "." + sign(data);
  };
  const decode = (value) => {
    try {
      const [data, sig] = value.split(".");
      if (!same(sign(data), sig)) return null;
      const parsed = JSON.parse(Buffer.from(data, "base64url"));
      return parsed.exp > Date.now() ? parsed : null;
    } catch {
      return null;
    }
  };
  const cookie = (token, maxAge = 28800) =>
    `__session=${token}; HttpOnly; SameSite=Strict; Path=${basePath}/; Max-Age=${maxAge}${config.APP_URL?.startsWith("https:") ? "; Secure" : ""}`;
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (basePath && (url.pathname === "/" || url.pathname === "" || url.pathname === basePath)) {
        res.writeHead(302, { Location: basePath + "/" });
        return res.end();
      }
      if (
        basePath &&
        url.pathname !== basePath &&
        !url.pathname.startsWith(basePath + "/")
      )
        throw fail(404, "File not found.");
      const route = url.pathname.slice(basePath.length) || "/";
      if (route === "/api/health" && req.method === "GET")
        return json(res, 200, { status: "ok", product: "PaperBridge" });
      const worker = route.match(
        /^\/api\/internal\/jobs\/([a-f0-9-]{36})\/run$/,
      );
      if (worker && req.method === "POST") {
        await jobs.verify(req.headers.authorization);
        await body(req);
        await jobs.run(worker[1]);
        return json(res, 200, { acknowledged: true });
      }
      if (route === "/api/showcase" && req.method === "GET") {
        let descriptor;
        try {
          descriptor = await store.get(showcaseDescriptor);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
        const paperId = descriptor?.paperId || config.SHOWCASE_PAPER_ID;
        if (!paperId) return json(res, 200, { available: false });
        const paper = await store.get(paperId);
        if (paper.mode !== "LIVE_UPLOAD")
          return json(res, 200, { available: false });
        const pageIndex = descriptor?.pageIndex ?? 0,
          page = paper.pages[pageIndex];
        const questions = paper.questions.filter(
          (q) => q.page === pageIndex + 1,
        );
        if (!page || !questions.length)
          return json(res, 200, { available: false });
        const fingerprint = createHash("sha256")
          .update(JSON.stringify({ page, questions }))
          .digest("hex");
        if (showcaseCache?.fingerprint === fingerprint)
          return json(res, 200, showcaseCache.value);
        if (showcasePending?.fingerprint === fingerprint)
          return json(res, 200, await showcasePending.promise);
        const promise = (async () => {
          let afterImage = null;
          try {
            afterImage = (
              await render({
                action: "preview",
                paper: {
                  name: "Digitized uploaded paper",
                  pages: [page],
                  questions,
                },
              })
            ).image;
          } catch { }
          const value = {
            available: true,
            sourcePage: page.sourcePage,
            beforeImage: page.rawImage || page.image,
            afterImage,
            questionCount: questions.length,
            verifiedCount: questions.filter(
              (q) => q.audit.status === "VERIFIED",
            ).length,
            reviewCount: questions.filter((q) => q.audit.status !== "VERIFIED")
              .length,
            createdAt: paper.createdAt,
          };
          showcaseCache = { fingerprint, value };
          return value;
        })();
        showcasePending = { fingerprint, promise };
        try {
          return json(res, 200, await promise);
        } finally {
          if (showcasePending?.promise === promise) showcasePending = null;
        }
      }
      if (route.startsWith("/api/")) {
        const allowedOrigins = new Set([
          config.APP_URL ? new URL(config.APP_URL).origin : null,
          `http://${req.headers.host}`,
          `https://${req.headers.host}`,
          `http://localhost:${config.PORT || 4310}`,
          `http://127.0.0.1:${config.PORT || 4310}`,
        ].filter(Boolean));
        const reqOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        if (req.method !== "GET" && reqOrigin && !allowedOrigins.has(reqOrigin))
          throw fail(
            403,
            "Open this portal at its configured APP_URL before submitting.",
          );
        const input = req.method === "GET" ? {} : await body(req);
        const cookies = Object.fromEntries(
          (req.headers.cookie || "").split(";").map((c) => {
            const i = c.indexOf("=");
            return [c.slice(0, i).trim(), c.slice(i + 1)];
          }),
        );
        const token = cookies.__session || cookies.pb_session;
        const session = token ? decode(token) : null;
        if (route === "/api/login" && req.method === "POST") {
          const ip = req.socket.remoteAddress || "unknown";
          for (const [key, item] of attempts)
            if (item.until < Date.now()) attempts.delete(key);
          const count = attempts.get(ip) || {
            value: 0,
            until: Date.now() + 900000,
          };
          if (count.value >= 10)
            throw fail(
              429,
              "Too many login attempts. Try again in 15 minutes.",
            );
          count.value++;
          attempts.set(ip, count);
          if (
            !same(input.email, config.JUDGE_EMAIL) ||
            !same(input.password, config.JUDGE_PASSWORD)
          )
            throw fail(401, "Email or access password is incorrect.");
          attempts.delete(ip);
          const next = {
            owner: randomUUID(),
            exp: Date.now() + 8 * 3600000,
            csrf: randomBytes(24).toString("hex"),
          };
          return json(
            res,
            200,
            {
              email: config.JUDGE_EMAIL,
              connectorConfigured: connector.configured,
            },
            { "Set-Cookie": cookie(encode(next)) },
          );
        }
        if (route.startsWith("/api/hosted/")) {
          const match = route.match(
            /^\/api\/hosted\/([^/]+)(?:\/(start|submit|import))?$/,
          );
          if (!match) throw fail(404, "Hosted test not found.");
          const grant = decode(match[1]);
          if (!grant || grant.kind !== "host")
            throw fail(404, "This hosting link has expired.");
          const paper = await store.get(grant.paperId);
          if (!paper.hosted) throw fail(404, "Hosted test unavailable.");
          if (req.method === "POST" && match[2] === "import") {
            if (!session)
              throw fail(
                401,
                "Sign in to create your private student analysis.",
              );
            return json(
              res,
              201,
              await studentCopy(store, paper, session.owner),
            );
          }
          if (req.method === "GET" && !match[2])
            return json(res, 200, publicPaper(paper));
          if (req.method === "POST" && match[2] === "start") {
            const attempt = {
              id: randomUUID(),
              paperId: paper.id,
              startedAt: Date.now(),
              exp: Date.now() + 24 * 3600000,
              kind: "attempt",
            };
            return json(res, 200, {
              attemptToken: encode(attempt),
              startedAt: attempt.startedAt,
            });
          }
          if (req.method === "POST" && match[2] === "submit") {
            const attempt = decode(input.attemptToken || "");
            if (
              !attempt ||
              attempt.kind !== "attempt" ||
              attempt.paperId !== paper.id
            )
              throw fail(403, "Start this test before submitting.");
            const result = await store.update(
              paper.id,
              null,
              async (current) => {
                const previous = current.attempts?.find(
                  (a) => a.id === attempt.id,
                );
                if (previous) return previous.result;
                if (
                  Date.now() >
                  attempt.startedAt + paper.durationMins * 60000 + 15000
                )
                  throw fail(
                    422,
                    "The timed attempt has expired. Start a new attempt.",
                  );
                const report = {
                  ...grade(current, input.answers),
                  kind: "HOSTED_ATTEMPT",
                  elapsedSeconds: Math.round(
                    (Date.now() - attempt.startedAt) / 1000,
                  ),
                  scopeLabel: `${current.questions.length} questions in this hosted test`,
                };
                current.attempts = [
                  ...(current.attempts || []).slice(-99),
                  {
                    id: attempt.id,
                    result: report,
                    at: new Date().toISOString(),
                  },
                ];
                return report;
              },
            );
            return json(res, 200, result);
          }
          throw fail(405, "Method not supported.");
        }
        if (!session)
          throw fail(401, "Sign in with the judge account to continue.");
        if (route === "/api/allowance" && req.method === "GET")
          return json(res, 200, await allowance.status(session.owner));
        const jobStatus = route.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
        if (jobStatus && req.method === "GET")
          return json(res, 200, await jobs.get(jobStatus[1], session.owner));
        if (route === "/api/papers/from-evidence" && req.method === "POST") {
          let descriptor;
          try {
            descriptor = await store.get(showcaseDescriptor);
          } catch (e) {
            if (e.status !== 404) throw e;
          }
          const id = descriptor?.paperId || config.SHOWCASE_PAPER_ID;
          if (!id)
            throw fail(
              422,
              "No saved uploaded-page evidence has been selected.",
            );
          const copy = await evidenceCopy(
            store,
            await store.get(id),
            descriptor?.pageIndex ?? 0,
            session.owner,
            input.journey || req.headers["x-paperbridge-journey"],
          );
          return json(res, 201, copy);
        }
        if (route === "/api/papers" && req.method === "GET")
          return json(res, 200, {
            papers: await listPapers(
              store,
              session.owner,
              journey(
                url.searchParams.get("journey") ||
                req.headers["x-paperbridge-journey"] ||
                "organization",
              ),
            ),
          });
        const retryMatch = route.match(
          /^\/api\/retries\/([^/]+)(?:\/(start|submit))?$/,
        );
        if (retryMatch) {
          const grant = decode(retryMatch[1]);
          if (!grant || grant.kind !== "retry" || grant.owner !== session.owner)
            throw fail(404, "Retry not found.");
          const retry = await store.get(grant.id, session.owner);
          if (req.method === "GET" && !retryMatch[2])
            return json(res, 200, publicPaper(retry));
          if (req.method === "POST" && retryMatch[2] === "start") {
            const result = await store.update(
              retry.id,
              session.owner,
              async (current) => {
                current.startedAt ||= Date.now();
                return {
                  startedAt: current.startedAt,
                  attemptToken: retryMatch[1],
                };
              },
            );
            return json(res, 200, result);
          }
          if (req.method === "POST" && retryMatch[2] === "submit") {
            const result = await store.update(
              retry.id,
              session.owner,
              async (current) => {
                if (current.report) return current.report;
                if (!current.startedAt)
                  throw fail(422, "Start your retry first.");
                if (
                  Date.now() >
                  current.startedAt + current.durationMins * 60000 + 15000
                )
                  throw fail(422, "This retry expired. Start a new retry.");
                current.report = {
                  ...grade(current, input.answers),
                  kind: "RETRY",
                  elapsedSeconds: Math.round(
                    (Date.now() - current.startedAt) / 1000,
                  ),
                  scopeLabel: `${current.questions.length} digitized questions; your original attempt is preserved`,
                };
                return current.report;
              },
            );
            return json(res, 200, result);
          }
          throw fail(405, "Method not supported.");
        }
        if (route === "/api/session" && req.method === "GET")
          return json(res, 200, {
            email: config.JUDGE_EMAIL,
            connectorConfigured: connector.configured,
          });
        if (route === "/api/logout" && req.method === "POST")
          return json(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie": [
                cookie("", 0),
                `pb_session=; HttpOnly; SameSite=Strict; Path=${basePath}/; Max-Age=0`,
              ],
            },
          );
        if (route === "/api/models" && req.method === "GET")
          return json(res, 200, await models.health());
        if (
          ["/api/render-pdf", "/api/inspect-pdf"].includes(route) &&
          req.method === "POST"
        ) {
          if (
            typeof input.base64 !== "string" ||
            input.base64.length > 34 * 1024 * 1024
          )
            throw fail(413, "PDF limit: 25 MB.");
          return json(
            res,
            200,
            await render({
              action: route.endsWith("inspect-pdf") ? "inspect" : "pdf",
              base64: input.base64,
              pageNumbers: input.pageNumbers,
              offset: input.offset,
            }),
          );
        }
        if (route === "/api/papers" && req.method === "POST") {
          const paper = {
            id: randomUUID(),
            owner: session.owner,
            journey: journey(
              input.journey ||
              req.headers["x-paperbridge-journey"] ||
              "organization",
            ),
            name: String(input.name || "Uploaded paper")
              .trim()
              .slice(0, 200),
            marks: 4,
            penalty: 1,
            durationMins: 10,
            questions: [],
            mode: "LIVE_UPLOAD",
            pages: [],
            createdAt: new Date().toISOString(),
          };
          await store.save(paper);
          await registerPaper(store, paper);
          return json(res, 201, paper);
        }
        const match = route.match(
          /^\/api\/papers\/([a-f0-9-]{36})(?:\/(pages|recover|audit|edit|responses|export|showcase|key|settings|analyze|analysis|host|publish|receipt|coach|voice|share-student|retry|jobs|selection))?$/,
        );
        if (!match) throw fail(404, "Endpoint not found.");
        const [, id, action] = match;
        const paper = await store.get(id, session.owner);
        assertScope(paper, req.headers["x-paperbridge-journey"]);
        if (
          [
            "host",
            "publish",
            "receipt",
            "showcase",
            "share-student",
            "selection",
          ].includes(action) &&
          journeyOf(paper) !== "organization"
        )
          throw fail(403, "Publishing belongs to the organization workspace.");
        if (
          [
            "responses",
            "analyze",
            "analysis",
            "retry",
            "coach",
            "voice",
          ].includes(action) &&
          journeyOf(paper) !== "student"
        )
          throw fail(
            403,
            "Open a private student paper to analyze an attempt or ask a doubt.",
          );
        if (paper.mode !== "LIVE_UPLOAD")
          throw fail(404, "Upload a real paper to begin.");
        if (!action && req.method === "GET") return json(res, 200, paper);
        if (action === "analysis" && req.method === "GET") {
          if (paper.originalAttempt)
            return json(
              res,
              200,
              (await store.get(paper.originalAttempt.id, session.owner)).report,
            );
          if (!paper.analysisAnswers)
            throw fail(404, "No original responses have been analyzed.");
          return json(res, 200, grade(paper, paper.analysisAnswers));
        }
        if (req.method === "GET" && action === "receipt") {
          if (!paper.publication)
            throw fail(404, "This paper has not been published.");
          const receipt = await connector.request(
            `/integrations/papers/${encodeURIComponent(paper.publication.testId)}`,
          );
          return json(res, 200, {
            ...receipt,
            readBackVerifiedAt: new Date().toISOString(),
          });
        }
        if (req.method !== "POST") throw fail(405, "Method not supported.");
        if (action === "share-student")
          return json(res, 201, await studentCopy(store, paper, session.owner));
        if (action === "retry") {
          if (
            !paper.questions.length ||
            paper.questions.some((q) => !Number.isInteger(q.correctIndex))
          )
            throw fail(422, "Complete the answer key before starting a retry.");
          const retry = {
            id: randomUUID(),
            owner: session.owner,
            kind: "RETRY",
            paperId: id,
            name: paper.name + " · Retry",
            marks: paper.marks,
            penalty: paper.penalty,
            durationMins: paper.durationMins,
            questions: structuredClone(paper.questions),
            mode: "RETRY",
            createdAt: new Date().toISOString(),
          };
          await store.save(retry);
          return json(res, 201, {
            token: encode({
              id: retry.id,
              owner: session.owner,
              kind: "retry",
              exp: Date.now() + 86400000,
            }),
          });
        }
        if (action === "jobs") {
          if (
            !input.input ||
            typeof input.input !== "object" ||
            Array.isArray(input.input)
          )
            throw fail(422, "Processing input is required.");
          return json(
            res,
            202,
            await jobs.enqueue(
              session.owner,
              paper,
              input.action,
              input.input,
              input.requestId,
            ),
          );
        }
        if (
          config.TASKS_QUEUE &&
          ["pages", "recover", "audit", "responses", "voice", "coach"].includes(
            action,
          )
        )
          throw fail(
            422,
            "Use the queued processing action so progress survives a page refresh.",
          );
        if (action === "showcase") {
          const pageIndex = Number(input.pageIndex);
          if (
            !paper.pages[pageIndex] ||
            !paper.questions.some((q) => q.page === pageIndex + 1)
          )
            throw fail(
              422,
              "Select a processed page with extracted questions.",
            );
          try {
            await store.get(showcaseDescriptor);
            await store.update(showcaseDescriptor, null, async (d) => {
              d.paperId = id;
              d.pageIndex = pageIndex;
            });
          } catch (e) {
            if (e.status !== 404) throw e;
            await store.save({
              id: showcaseDescriptor,
              kind: "INTRODUCTION_PROOF",
              paperId: id,
              pageIndex,
            });
          }
          showcaseCache = null;
          return json(res, 200, { published: true });
        }
        if (action === "export") {
          if (!["clean", "typeset"].includes(input.format))
            throw fail(422, "Choose cleaned scan or typeset PDF.");
          if (
            !paper.pages.length ||
            (input.format === "typeset" && !paper.questions.length)
          )
            throw fail(422, "Digitize at least one uploaded page first.");
          return json(
            res,
            200,
            await render({
              action: "export",
              format: input.format,
              paper: { ...paper, questions: includedQuestions(paper) },
            }),
          );
        }
        if (action === "voice")
          return json(
            res,
            200,
            await runAs(session.owner, () =>
              models.transcribe(String(input.audioBase64 || "")),
            ),
          );
        if (action === "coach") {
          const question = paper.questions.find(
            (q) => q.id === input.questionId,
          );
          if (!question) throw fail(404, "Question not found.");
          const doubt = String(input.doubt || "").slice(0, 4000);
          if (!doubt.trim())
            throw fail(422, "Ask a question or record your doubt.");
          return json(res, 200, {
            ...(await runAs(session.owner, () =>
              models.coach(
                question,
                doubt,
                Array.isArray(input.history) ? input.history : [],
              ),
            )),
            mode: "LIVE",
          });
        }
        const result = await store.update(id, session.owner, (current) =>
          mutatePaper(current, action, input, session.owner),
        );
        return json(res, 200, result);
      }
      if (req.method !== "GET") throw fail(405, "Method not supported.");
      const pdfVendor = route.startsWith("/vendor/pdfjs/");
      const vendor = route.startsWith("/vendor/katex/") || pdfVendor;
      const base = pdfVendor ? pdfjsDir : vendor ? katexDir : publicDir;
      const target = vendor
        ? resolve(
          base,
          decodeURIComponent(
            route.slice(
              (pdfVendor ? "/vendor/pdfjs/" : "/vendor/katex/").length,
            ),
          ),
        )
        : ["/", "/organization", "/student", "/judge"].includes(route) ||
          route.startsWith("/t/") ||
          route.startsWith("/test/") ||
          route.startsWith("/retry/")
          ? resolve(publicDir, "index.html")
          : resolve(publicDir, "." + decodeURIComponent(route));
      if (!target.startsWith(base + sep)) throw fail(404, "File not found.");
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".ttf": "font/ttf",
        ".wasm": "application/wasm",
      };
      let data;
      try {
        data = await readFile(target);
      } catch {
        throw fail(404, "File not found.");
      }
      if (extname(target) === ".html")
        data = Buffer.from(
          data
            .toString()
            .replace(
              "<head>",
              `<head><meta name="app-base" content="${basePath}">`,
            )
            .replaceAll('href="/', 'href="' + basePath + "/")
            .replaceAll('src="/', 'src="' + basePath + "/"),
        );
      res.writeHead(200, {
        "Content-Type": types[extname(target)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch (error) {
      json(res, error.status || 500, {
        error: error.status
          ? error.message
          : "An unexpected server error occurred. Retry or check server logs.",
      });
      if (!error.status) console.error(error);
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createApp();
  server.listen(
    Number(process.env.PORT || 4310),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        `PaperBridge: ${process.env.APP_URL || "http://localhost:4310"}`,
      ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}

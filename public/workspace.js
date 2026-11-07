import { introduction } from "./introduction.js";
import { pageBrowser } from "./page-browser.js";
import { hasUsableKey, isVerifiedForHosting } from "./hosting.js";
import {
  journeys,
  workspaceHome,
  hostView,
  integrationView,
  retryView,
  judgeView,
} from "./journeys.js";
import { mountAssessment } from "./assessment.js";
import { processingClient } from "./processing.js";
import {
  openPdf,
  inspectPdf,
  renderPdfPage,
  imagePreview,
} from "./pdf-browser.js";
const BASE = document.querySelector('meta[name="app-base"]')?.content || "";
const { default: katex } = await import(BASE + "/vendor/katex/katex.mjs");
const $ = (selector) => document.querySelector(selector);
const searchParams = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
const demoMode = searchParams?.get("demo");
const S = {
  signedIn: false,
  view: demoMode === "upload" ? "upload" : demoMode === "judge" ? "judge" : "home",
  journey:
    demoMode === "student"
      ? "student"
      : ["organization", "student"].find((v) =>
          location.pathname.endsWith("/" + v),
        ) ||
        sessionStorage.getItem("pb-journey") ||
        "organization",
  intro: demoMode ? false : location.pathname === "/",
  library: [],
  paper: null,
  report: null,
  models: null,
  busy: false,
  error: "",
  message: "",
  progress: "",
  queue: [],
  cursor: 0,
  pageIndex: 0,
  responses: [],
  chat: [],
  coachIndex: 0,
  doubt: "",
  recording: false,
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const button = (action, label, secondary = false, extra = "") =>
  `<button class="btn ${secondary ? "secondary" : ""}" data-action="${action}" ${S.busy ? "disabled" : ""} ${extra}>${label}</button>`;
const img = (src, alt, cls = "diagram") =>
  src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" class="${cls}" loading="lazy">`
    : "";
const math = (value) =>
  String(value ?? "")
    .split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g)
    .map((part) =>
      part.startsWith("$")
        ? katex.renderToString(part.replace(/^\$\$?|\$\$?$/g, ""), {
            throwOnError: false,
            trust: false,
            displayMode: part.startsWith("$$"),
          })
        : esc(part).replaceAll("\n", "<br>"),
    )
    .join("");
const badge = (status) =>
  `<span class="pill ${status === "VERIFIED" ? "good" : "warn"}">${esc(status.toLowerCase().replaceAll("_", " "))}</span>`;
async function api(path, data) {
  const response = await fetch(BASE + "/api" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PaperBridge-Journey": S.journey,
    },
    credentials: "same-origin",
    signal: AbortSignal.timeout(90000),
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json().catch(() => {
    throw new Error("PaperBridge returned an unreadable response. Check the connection and try again.");
  });
  if (!response.ok) {
    if (response.status === 401) S.signedIn = false;
    throw new Error(value.error || `Request failed (${response.status})`);
  }
  return value;
}
// Metadata must never hold the judge's next action or reset a form being edited.
function renderWhenIdle() {
  if (S.busy || document.activeElement?.matches("input, textarea, select")) return;
  render();
}
async function refreshMetadata() {
  await Promise.allSettled([
    api("/models").then((value) => { S.models = value; }),
  ]);
  document.querySelectorAll(".pipeline").forEach((element) => { element.outerHTML = pipeline(); });
}
const processing = processingClient({ api, state: S, render });
const infer = (path, input) => processing.run(path, input);
async function task(fn, progress) {
  if (S.busy) return;
  if (S.recording) {
    S.error = "Stop your recording before changing pages or starting another action.";
    render();
    return;
  }
  S.busy = true;
  S.error = "";
  S.message = "";
  S.progress = progress || "Working…";
  render();
  try {
    await fn();
    if (S.paper)
      sessionStorage.setItem("pb-" + S.journey + "-paper", S.paper.id);
  } catch (e) {
    S.error = e.message;
  } finally {
    S.busy = false;
    S.progress = "";
    render();
    if (S.error) S.focusTarget = '[role="alert"]';
    const target = S.focusTarget;
    S.focusTarget = null;
    if (target) requestAnimationFrame(() => {
      const element = $(target);
      element?.scrollIntoView({ block: "start", behavior: "instant" });
      if (element) { element.setAttribute("tabindex", "-1"); element.focus({ preventScroll: true }); }
    });
  }
}
function notices() {
  return `${S.error ? `<div class="notice error" role="alert">${esc(S.error)}${!S.busy && sessionStorage.getItem("pb-" + S.journey + "-pending-job") ? '<p><button class="btn secondary" data-action="resume-processing">Resume saved progress</button></p>' : ""}</div>` : ""}${S.message ? `<div class="notice" role="status">${esc(S.message)}</div>` : ""}${S.progress ? `<div class="progress" role="status"><span class="spinner"></span>${esc(S.progress)}</div>` : ""}`;
}
function login() {
  return introduction(S, { esc, img, button, pipeline });
}
const helpers = { esc, img, button, math };
const roleCache = {};
const roleKeys = [
  "paper",
  "report",
  "view",
  "queue",
  "selection",
  "document",
  "queueIndex",
  "cursor",
  "pageIndex",
  "responses",
  "responseEvidence",
  "chat",
  "coachIndex",
  "doubt",
  "library",
  "regionBox",
  "cropping",
  "lightboxPage",
  "compareSource",
  "compareZoom",
];
const cleanRole = () => ({
  paper: null,
  report: null,
  view: "home",
  queue: [],
  selection: [],
  document: null,
  queueIndex: 0,
  cursor: 0,
  pageIndex: 0,
  responses: [],
  responseEvidence: {},
  chat: [],
  coachIndex: 0,
  doubt: "",
  library: [],
  regionBox: null,
  cropping: false,
  lightboxPage: null,
  compareSource: false,
  compareZoom: false,
});
async function loadLibrary() {
  S.library = (await api("/papers?journey=" + S.journey)).papers;
}
async function resumeProcessing() {
  const resumed = await processing.resume();
  if (!resumed) return;
  if (resumed.result?.questions) {
    S.paper = resumed.result;
    S.view = resumed.job.action === "audit-selection" ? "host" : "review";
  }
  if (resumed.job.action === "voice") {
    S.doubt = resumed.result.transcript;
    S.view = "coach";
  }
  if (resumed.job.questionId)
    S.coachIndex = Math.max(
      0,
      S.paper.questions.findIndex((q) => q.id === resumed.job.questionId),
    );
  if (resumed.job.action === "coach") {
    S.chat = [{ role: "coach", text: resumed.result.hint }];
    S.view = "coach";
  }
  S.message =
    "Resumed the saved processing job without starting a new inference.";
}
async function openPaper(id, resume = true) {
  S.paper = await api("/papers/" + id);
  S.pageIndex = 0;
  S.coachIndex = 0;
  S.chat = [];
  S.doubt = "";
  S.regionBox = null;
  S.responseEvidence = {};
  S.lightboxPage = null;
  S.compareSource = false;
  S.focusTarget = ".section-head";
  S.report = null;
  S.responses = [];
  S.document = null;
  S.queue = [];
  S.selection = [];
  S.view = S.paper.pages.length ? "review" : "upload";
  if (S.paper.activeJob)
    sessionStorage.setItem(
      "pb-" + S.journey + "-pending-job",
      S.paper.activeJob.id,
    );
  if (S.paper.originalAttempt) {
    S.report = await api(`/papers/${id}/analysis`);
    S.responses = S.report.review.map((q) => q.answer);
    S.view = "results";
  }
  if (resume && S.paper.activeJob) await resumeProcessing();
}
async function enterJourney(role, view = "home") {
  if (!journeys[role]) throw new Error("Choose a workspace.");
  if (S.journey !== role) {
    roleCache[S.journey] = Object.fromEntries(roleKeys.map((k) => [k, S[k]]));
    Object.assign(S, cleanRole(), roleCache[role] || {});
  }
  S.journey = role;
  S.view = view;
  S.intro = false;
  S.error = "";
  S.message = "";
  sessionStorage.setItem("pb-journey", role);
  history.pushState({}, "", BASE + "/" + role);
  if (S.signedIn) await loadLibrary();
  render();
  window.scrollTo({ top: 0 });
}
function canOpenView(id) {
  if (["home", "upload", "judge"].includes(id)) return true;
  if (id === "results") return Boolean(S.report);
  if (["review", "export"].includes(id)) return Boolean(S.paper?.pages.length);
  return Boolean(S.paper?.questions.length);
}
function shell(content) {
  const j = journeys[S.journey],
    views = j.views;
  return `<div class="shell"><aside class="sidebar"><a href="/" class="brand"><img src="/assets/icon.svg" alt="">PaperBridge</a><div class="eyebrow muted side-description">${j.label} workspace</div><nav class="side-nav" aria-label="${j.label} workflow">${views.map(([id, n, label]) => `<button data-action="nav" data-view="${id}" class="${S.view === id ? "active" : ""}" ${S.busy || !canOpenView(id) ? "disabled" : ""}><span class="num">${n}</span>${label}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="sidebar-note"><strong>${S.journey === "student" ? "Your original attempt stays yours" : "From source to a reviewed test"}</strong>${S.journey === "student" ? "Confirm actual responses. A retry records a separate attempt." : "Preserve source visuals, check the key and host a stable paper version."}</div></div></aside><div class="workspace"><header class="topbar"><button class="reset" data-action="intro">Introduction ↗</button><div class="journey-switch" aria-label="Switch workspace">${Object.entries(
    journeys,
  )
    .map(
      ([id, v]) =>
        `<button data-action="choose-journey" data-journey="${id}" aria-pressed="${S.journey === id}" ${S.busy ? "disabled" : ""}>${v.label}</button>`,
    )
    .join(
      "",
    )}</div><div class="stack"><button class="reset" data-action="judge" ${S.busy ? "disabled" : ""}>Judge guide</button><button class="reset" data-action="logout" ${S.busy ? "disabled" : ""}>Sign out</button></div></header><main class="content">${pipeline()}${notices()}${S.paper?.evidenceOrigin ? `<div class="notice">Saved real-paper example · responses entered here describe practice with this example.</div>` : ""}${content}<footer class="footer"><span>PaperBridge · ${j.label} workspace</span><span>Source visuals · Traceable checks · Your own paper</span></footer></main></div></div>`;
}
function pipeline() {
  return `<div class="pipeline">${[
    ["sam-3.1", "SAM 3.1", "Locate diagrams, graphs and tables"],
    [
      "muse-spark-1.3",
      "Muse Spark 1.3",
      "Extract questions, choices and visible marks",
    ],
    [
      "muse-wonder-1.0",
      "Muse Wonder 1.0",
      "Independently audit and confirm key repairs",
    ],
    [
      "muse-voice-transcribe-1.0",
      "Muse Voice Transcribe",
      "Transcribe actual spoken doubts",
    ],
  ]
    .map(
      ([id, title, text]) => {
        const found = S.models?.models?.find((m) => m.id === id);
        const statusLabel = found?.status === "AVAILABLE" ? "available" : found ? found.status.toLowerCase().replaceAll("_", " ") : "Not checked yet";
        return `<article><b>${title}</b><small>${text}</small><span class="status" style="color:#059669;font-weight:600;display:inline-flex;align-items:center;gap:4px"><span style="color:#10b981">●</span> ${esc(statusLabel)}</span></article>`;
      }
    )
    .join("")}</div>`;
}
function uploadView() {
  return `<section class="section-head"><div class="eyebrow muted">Upload locally. Select deliberately.</div><h2>Choose any three pages from your paper.</h2><p>The full PDF is available in the page browser. Meta runs only on the specific page you choose to digitize. Text-dominant pages use Spark without SAM or Wonder.</p></section><section class="card"><div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #e2e8f0"><div style="max-width:480px"><strong style="font-size:14px;color:#1e293b;display:block">Instant Judge Demo · No local file needed</strong><small class="muted">Click below to load a real scanned competitive exam paper (NEET / GATE Physics) directly into the page browser.</small></div><button class="btn secondary" data-action="load-sample" id="load-sample-btn" type="button" ${S.busy ? "disabled" : ""} style="background:#ecfdf5;color:#047857;border-color:#a7f3d0;font-weight:600;display:inline-flex;align-items:center;gap:6px"><span>📄</span> Load Sample Exam Paper (NEET / GATE)</button></div><div class="settings-grid"><label>Input format<select id="scan-mode"><option value="auto">Auto-detect</option><option value="photo">Photographed / distorted</option><option value="digital">Digital PDF / clean scan</option></select></label><label>Subject hint<input id="subject" value="Physics" placeholder="Subject hint"></label></div><label class="dropzone"><input id="paper-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" ${S.busy ? "disabled" : ""}><span class="upload-icon">↥</span><strong>Load your PDF or photographed page</strong><small>All pages can be browsed · maximum 3 chosen for this judge run · 25 MB<br>Upload, thumbnails and page selection make no Meta inference requests.</small></label></section>${pageBrowser(S, { esc, img, button })}`;
}
function optionList(q, showKey = false, selected = null) {
  return `<div class="options">${q.options.map((o, i) => `<div class="option ${showKey && i === q.correctIndex ? "correct" : ""} ${showKey && selected === i && i !== q.correctIndex ? "wrong" : ""}"><span class="letter">${String.fromCharCode(65 + i)}</span><div class="option-body">${math(o.text)}${img(o.imageUrl, "Original option " + String.fromCharCode(65 + i), "")}</div>${showKey && i === q.correctIndex ? "✓" : ""}</div>`).join("")}</div>`;
}
const paperLocked = () => Boolean(S.paper?.hosted || S.paper?.publication || S.paper?.originalAttempt);
const boxText = (box) => (Array.isArray(box) ? box.join(", ") : "");
function sourcePanel() {
  const p = S.paper.pages[S.pageIndex];
  if (!p) return "";
  return `<section class="card source-review" style="margin-bottom:22px"><div class="spread"><h3>Original → cleaned source</h3><label>Source page<select id="source-page">${S.paper.pages.map((p, i) => `<option value="${i}" ${i === S.pageIndex ? "selected" : ""}>${esc(p.filename || "Upload")} · page ${p.sourcePage}</option>`).join("")}</select></label></div><div class="action-bar">${button("compare-source", "Compare original & digitized page ↗", true)}</div><div class="grid2 source-comparison"><div><p class="eyebrow muted">Original upload</p>${img(p.rawImage || p.image, "Original uploaded page", "source-document")}</div><div><p class="eyebrow muted">Processed page + SAM regions</p><div class="source-preview" id="region-source">${img(p.image, "Cleaned page", "source-document")}${p.boxes.map((b) => `<div class="bounding-box" style="left:${b.box[0] / 10}%;top:${b.box[1] / 10}%;width:${(b.box[2] - b.box[0]) / 10}%;height:${(b.box[3] - b.box[1]) / 10}%"><span>${esc(b.label)}</span></div>`).join("")}</div></div></div><p class="small muted">${p.processing?.perspectiveCorrected ? "Perspective corrected. " : ""}${p.processing?.rotationDegrees ? `Rotation corrected by ${p.processing.rotationDegrees}°. ` : ""}${p.processing?.illuminationNormalized ? "Uneven illumination normalized." : "Native page preserved."} Coordinates and crops refer to the processed page. ${p.questionCount} questions extracted. Model requests: ${p.modelUsage?.used ?? "prior run"} / ${p.modelUsage?.max ?? "not recorded"}.</p><p class="small muted">${p.coverage?.missingNumbers?.length ? "Unresolved source question numbers: " + esc(p.coverage.missingNumbers.join(", ")) : ""}</p>${button("recover", "Check one missing visual block · up to 2 requests", true, paperLocked() ? "disabled" : "")}<p class="small muted">Publishing this source page as the introduction makes its before/after preview visible to judges.</p>${button("use-showcase", "Use this page in the introduction", true)}<details class="key-entry"><summary>Recover a folded or missed question with one Spark request</summary><p class="small muted">Select a rectangle on the processed page around one complete question and every option. This avoids reprocessing the page. No Wonder audit runs unless you request it separately.</p>${button("select-region", "Select source region", true, paperLocked() ? "disabled" : "")}<form id="region-form" class="fields" style="margin-top:15px"><label>Source region (left, top, right, bottom)<input id="manual-region-box" name="box" value="${S.regionBox ? S.regionBox.join(", ") : ""}" required></label><label>Printed question number, if readable<input name="sourceNumber" maxlength="4"></label><button class="btn" ${S.busy || paperLocked() ? "disabled" : ""}>Extract this region · maximum 1 Spark request</button></form></details></section>`;
}
function editor(q, index) {
  return `<details class="question-editor"><summary>Edit this question and its source crops</summary><form class="edit-form fields" data-id="${q.id}"><div class="grid2"><div>${img(q.sourceSnippet, "Complete original question crop", "source-question")}<p class="small muted">Source page ${q.sourcePage || q.page}. Crop coordinates use left, top, right, bottom on a 0–1000 page scale. Blank a diagram crop to remove it; source pixels stay preserved.</p></div><div class="fields"><label>Printed question number<input name="sourceNumber" value="${esc(q.sourceNumber || "")}" maxlength="4"></label><label>Question text / LaTeX<textarea name="text" rows="6" required>${esc(q.text)}</textarea></label><label>Topic<input name="topic" value="${esc(q.topic)}"></label><label>Whole question crop<input name="sourceBox" value="${boxText(q.sourceBox)}" placeholder="left, top, right, bottom"></label><label>Question diagram crop<input name="diagramBox" value="${boxText(q.diagramBox)}" placeholder="left, top, right, bottom"></label></div></div>${q.options.map((o, i) => `<div class="grid2"><label>Option ${String.fromCharCode(65 + i)} text<textarea name="option-${i}" rows="2">${esc(o.text)}</textarea></label><label>Option ${String.fromCharCode(65 + i)} image crop<input name="box-${i}" value="${boxText(o.imageBox)}" placeholder="Blank for text-only option"></label></div>`).join("")}<label>Answer key<select name="correctIndex"><option value="">Unknown / not yet verified</option>${q.options.map((_, i) => `<option value="${i}" ${q.correctIndex === i ? "selected" : ""}>${String.fromCharCode(65 + i)}</option>`).join("")}</select></label><label>Explanation / LaTeX<textarea name="explanation" rows="4">${esc(q.explanation)}</textarea></label><button class="btn" ${S.busy || S.paper.hosted || S.paper.publication || S.paper.originalAttempt ? "disabled" : ""}>Save changes & invalidate old audit</button></form></details>`;
}
function reviewView() {
  return `<section class="section-head"><div class="eyebrow muted">02 / Source-grounded digitization</div><h2>${esc(S.paper.name)}</h2><p>${S.paper.questions.length} questions from ${S.paper.pages.length} selected pages. Compare the original, inspect the cropped visuals, and edit text or crop boundaries. Saving an edit requires a fresh audit before hosting.</p></section><div class="action-bar">${button("nav", S.journey === "organization" ? "Continue to Host a test →" : "Continue to My original responses →", false, `data-view="${S.journey === "organization" ? "host" : "responses"}" ${S.paper.questions.length ? "" : "disabled"}`)}</div>${sourcePanel()}${S.paper.questions.length ? "" : '<div class="notice info">No questions were found on these completed pages. Instruction/blank pages are retained; choose a question-bearing page to continue.</div>'}${S.paper.questions.map((q, i) => `<article class="card question-card"><div class="question-head"><span class="eyebrow muted">Q${esc(q.sourceNumber || i + 1)} · ${esc(q.topic)}</span>${badge(q.audit.status)}</div><p class="question-text">${math(q.text)}</p>${img(q.imageUrl, "Original diagram crop")}${optionList(q, true)}${q.repair ? `<div class="notice small">Autonomous key repair ${q.repair.confirmed ? "confirmed" : "not confirmed"}: ${q.repair.originalIndex === null ? "unknown" : String.fromCharCode(65 + q.repair.originalIndex)} → ${String.fromCharCode(65 + q.repair.proposedIndex)}. Both audits remain available below.</div>` : ""}<details class="audit"><summary>Audit, explanation & detected response</summary><p>${math(q.audit.proof)}</p><p>${math(q.explanation)}</p><p><strong>Visible student mark:</strong> ${q.studentResponse?.selectedIndex === null ? "No unambiguous option detected" : String.fromCharCode(65 + q.studentResponse.selectedIndex)}. ${esc(q.studentResponse?.evidence || "")}</p>${q.repair ? `<p>${math(q.repair.initialProof)}</p><p>${math(q.repair.confirmationProof)}</p>` : ""}</details>${button("audit", "Verify this question · up to 2 requests", true, `data-id="${q.id}" ${q.audit.status === "VERIFIED" || paperLocked() ? "disabled" : ""}`)}${editor(q, i)}</article>`).join("")}<div class="action-bar"><div><strong class="small">${paperLocked() ? "This saved paper version is locked" : "Every field remains editable"}</strong><br><small>Inferred keys are estimates until checked against an authoritative key.</small></div><div class="stack"><span class="small muted">Verify questions here, or verify your selection together in Host a test.</span>${S.cursor < S.queue.length ? button("nav", "Choose next selected page", true, 'data-view="upload"') : ""}${button("nav", "Export this paper →", false, 'data-view="export"')}</div></div>`;
}
function exportView() {
  return `<section class="section-head"><div class="eyebrow muted">03 / From image to usable paper</div><h2>A clean copy. Editable content.</h2><p>Export only what came from your selected uploaded pages. The cleaned scan preserves their layout; the typeset paper uses the current edited questions and original visual crops.</p></section><div class="grid2"><section class="card"><h3>Cleaned source PDF</h3><p class="small muted">Perspective and illumination corrections on photographed pages. Original question layout and diagrams remain visible.</p>${button("export-clean", "Download cleaned scan PDF ↧")}</section><section class="card"><h3>Digitized question paper PDF</h3><p class="small muted">Selectable question text, rendered formulas and original diagram crops. Questions use your latest edits. No answer key is printed.</p>${button("export-typeset", "Download digitized paper PDF ↧")}</section><section class="card"><h3>Editable question data</h3><p class="small muted">Download structured JSON containing text, choices, source crops, crop coordinates and audit provenance. The in-app editor remains the fastest way to make corrections.</p>${button("export-json", "Download editable JSON ↧", true)}</section>${S.journey === "organization" ? `<section class="card"><h3>Host a reviewed test</h3><p class="small muted">Create a stable assessment and share it with students once the questions are ready.</p>${button("nav", "Prepare hosted test →", true, 'data-view="host"')}</section>` : ""}</div>`;
}
function responsesView() {
  return `<section class="section-head"><div class="eyebrow muted">04 / Your actual attempt</div><h2>What did you mark?</h2><p>Review marks found on the uploaded paper, upload your OMR, or enter your responses. Detected marks are proposals: confirm or correct them before scoring. Uncertain or multiple marks remain blank.</p></section><div class="grid2"><section class="card"><h3>Marks on the paper</h3><p class="small muted">${S.paper.questions.filter((q) => q.studentResponse?.selectedIndex !== null && q.studentResponse?.confidence >= 0.9).length} high-confidence marks detected. Printed option labels and AI-derived answers are not treated as student responses.</p>${button("use-marks", "Review detected paper marks", true)}</section><section class="card"><h3>Read an OMR / response sheet</h3><label class="dropzone" style="min-height:130px"><input id="omr-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" ${S.busy ? "disabled" : ""}><strong>Upload your marked OMR or answer sheet</strong><small>First PDF page or one image · Matched by printed question number</small></label>${S.paper.responseDetections ? `<p class="small muted">${S.paper.responseDetections.length} matching rows read. Uncertain rows need manual review.</p>${button("use-omr", "Review detected OMR marks", true)}` : ""}</section></div><section class="card" style="margin-top:22px">${S.paper.originalAttempt ? `<div class="notice">Your original attempt is saved. Start a separate retry to record new answers.</div>${button("nav", "Open a separate retry →", true, 'data-view="retry"')}` : ""}<form id="responses-form"><fieldset class="response-fields" ${S.paper.originalAttempt ? "disabled" : ""}><div class="answer-grid">${S.paper.questions.map((q, i) => `<label class="answer-row"><span class="eyebrow">Q${esc(q.sourceNumber || i + 1)}</span><div><p>${esc(q.text)}</p><small>${esc(S.responseEvidence?.[q.id] || q.studentResponse?.evidence || "Enter your own response.")}</small></div><select name="answer-${i}" aria-label="Your answer to question ${esc(q.sourceNumber || i + 1)}"><option value="">Unresolved / not confirmed</option><option value="skip" ${S.responses[i] === null ? "selected" : ""}>I skipped this question</option>${q.options.map((_, j) => `<option value="${j}" ${S.responses[i] === j ? "selected" : ""}>${String.fromCharCode(65 + j)}</option>`).join("")}</select></label>`).join("")}</div><button class="btn" ${S.busy ? "disabled" : ""}>Confirm these responses & analyze →</button></fieldset></form><details class="key-entry"><summary>Use an official or coaching answer key</summary><p class="small muted">Enter one letter per extracted question, in the displayed order. The key's provenance is supplied by you, not certified by PaperBridge.</p><form id="key-form" class="stack"><input name="key" placeholder="Answer letters in displayed order" required><button class="btn secondary" ${S.busy || S.paper.hosted || S.paper.originalAttempt ? "disabled" : ""}>Apply my key</button></form></details><form id="marking-form" class="stack" style="margin-top:20px"><label>Marks / correct<input name="marks" type="number" value="${S.paper.marks}" min="1" max="4" required></label><label>Penalty / wrong<select name="penalty">${[0, 0.25, 0.5, 1].map((v) => `<option ${v === S.paper.penalty ? "selected" : ""}>${v}</option>`).join("")}</select></label><button class="btn secondary" ${S.busy || S.paper.hosted || S.paper.originalAttempt ? "disabled" : ""}>Save marking scheme</button></form></section>`;
}
function resultsView() {
  const r = S.report;
  return `<section class="section-head"><div class="eyebrow muted">05 / Performance insights</div><h2>Understand what happened.</h2><p>${esc(r.keyLabel)}</p><p class="small muted">${esc(r.scopeLabel || `${r.review.length} digitized questions`)}. This is not a full-paper score.</p></section><div class="metrics"><div class="metric primary"><small>Marks among digitized questions</small><strong>${r.score}<span> / ${r.maxScore}</span></strong></div><div class="metric"><small>Correct</small><strong>${r.correct}</strong></div><div class="metric"><small>Incorrect</small><strong>${r.incorrect}</strong></div><div class="metric"><small>Confirmed skipped</small><strong>${r.unattempted}</strong></div></div><div class="action-bar">${button("nav", "Ask my coach →", false, 'data-view="coach"')}${button("nav", "Try a separate timed retry →", true, 'data-view="retry"')}</div><section class="card"><h3>Topics to revisit</h3><p class="small muted">Prioritized by marks lost in the responses you confirmed. A few questions suggest review areas; they do not establish mastery.</p>${r.topics.map((t) => `<div class="topic"><div class="spread"><strong>${esc(t.topic)}</strong><span class="small">${t.correct}/${t.total} correct · ${t.lostMarks} marks to recover</span></div><div class="bar"><span style="width:${(t.correct / t.total) * 100}%"></span></div></div>`).join("")}</section>${r.review.map((q, i) => `<article class="card question-card" style="margin-top:20px"><div class="spread"><span class="eyebrow muted">Q${esc(q.sourceNumber || i + 1)} · ${esc(q.topic)}</span><span class="pill ${q.status === "CORRECT" ? "good" : "warn"}">${esc(q.status.toLowerCase())} · ${q.marks}</span></div><p class="question-text" style="margin-top:15px">${math(q.text)}</p>${img(q.imageUrl, "Question diagram")}${optionList(q, true, q.answer)}${q.misconception ? `<div class="trap"><b>A possible reasoning trap to explore</b>${esc(q.misconception)}</div>` : ""}<details class="audit"><summary>See the reasoning</summary><p>${math(q.explanation)}</p></details>${button("coach-question", "Work through this with the coach →", true, `data-index="${i}"`)}</article>`).join("")}`;
}
function coachView() {
  const q = S.paper.questions[S.coachIndex];
  if (!q) return '<div class="notice info">Digitize a question first.</div>';
  return `<section class="section-head"><div class="eyebrow muted">06 / A coach for this actual question</div><h2>Ask where your reasoning broke.</h2><p>Speak in English or Hinglish, or type your doubt. The live coach uses the selected question to offer a guiding step rather than a memorized answer.</p></section><div class="coach-layout"><section class="card"><label>Question<select id="coach-question">${S.paper.questions.map((q, i) => `<option value="${i}" ${i === S.coachIndex ? "selected" : ""}>Q${esc(q.sourceNumber || i + 1)} · ${esc(q.topic)}</option>`).join("")}</select></label><p class="question-text" style="margin-top:20px">${math(q.text)}</p>${img(q.imageUrl, "Question source diagram")}${optionList(q)}</section><section class="card"><h3>Think it through</h3><div class="chat" aria-live="polite">${S.chat.map((m, i) => `<div class="bubble ${m.role === "student" ? "student" : ""}"><small>${m.role === "student" ? "Your doubt" : "Live Socratic coach"}</small>${esc(m.text)}${m.role === "coach" ? "<br>" + button("speak", "Listen", true, `data-index="${i}"`) : ""}</div>`).join("")}</div><form id="coach-form"><label>Your doubt<textarea name="doubt" id="doubt" required placeholder="Describe the step you are unsure about…">${esc(S.doubt)}</textarea></label><div class="recorder"><button type="button" class="mic ${S.recording ? "recording" : ""}" data-action="record" ${S.busy ? "disabled" : ""} aria-label="${S.recording ? "Stop recording" : "Record your doubt"}">${S.recording ? "■" : "●"}</button><span class="small muted">${S.recording ? "Recording · Stop when finished" : "Record up to 30 seconds · Actual Meta transcription"}</span></div><button class="btn" ${S.busy || S.recording ? "disabled" : ""}>Ask for a guiding step →</button></form><p class="small muted" style="margin-top:18px">Voice transcription uses Meta. Optional audio playback uses your browser's speech synthesis.</p></section></div>`;
}
function floatingProgress() {
  if (!S.busy) return "";
  return `<div class="floating-progress-bar" role="status" aria-live="polite">
    <div class="floating-progress-card">
      <div class="spinner-ring"></div>
      <div class="floating-progress-content">
        <strong class="floating-progress-title">PaperBridge is working</strong>
        <span class="floating-progress-desc">${esc(S.progress || "Working…")}</span>
      </div>
    </div>
  </div>`;
}
function lightboxModal(S, { esc }) {
  if (S.compareSource && S.paper) {
    const p = S.paper.pages[S.pageIndex];
    const questions = S.paper.questions.filter((q) => q.page === S.pageIndex + 1);
    return `<div class="lightbox-overlay" data-action="close-lightbox" role="dialog" aria-modal="true" aria-label="Original and digitized comparison"><div class="lightbox-container comparison-dialog"><div class="lightbox-header"><div><strong>Source page ${p.sourcePage} → ${questions.length} digitized questions</strong><p class="small muted">Compare the original scan with extracted text, formulas and preserved visuals.</p></div><button class="btn secondary" data-action="close-lightbox">✕ Close</button></div><div class="comparison-panes"><section><h3>Original uploaded page</h3><div class="comparison-scroll"><img data-action="compare-zoom" class="comparison-source ${S.compareZoom ? "zoomed" : ""}" src="${esc(p.rawImage || p.image)}" alt="Original source page ${p.sourcePage}"></div></section><section><h3>Digitized and editable</h3><div class="comparison-scroll">${questions.map((q, i) => `<article class="card question-card"><div class="spread"><strong>Q${esc(q.sourceNumber || i + 1)}</strong>${badge(q.audit.status)}</div><p class="question-text">${math(q.text)}</p>${img(q.imageUrl, "Preserved question diagram")}${optionList(q)}</article>`).join("") || '<p>No question text was extracted from this page. Review the source before recovery.</p>'}</div></section></div></div></div>`;
  }
  if (!S.lightboxPage || !S.document) return "";
  const pNum = S.lightboxPage;
  const imgUrl = S.document.hiresPages?.[pNum] || S.document.metadata?.[pNum - 1]?.thumbnail || "";
  return `<div class="lightbox-overlay" data-action="close-lightbox" role="dialog" aria-modal="true" aria-label="Page ${pNum} Preview">
    <div class="lightbox-container">
      <div class="lightbox-header">
        <div class="lightbox-title">
          <strong>Page ${pNum} of ${S.document.pageCount}</strong>
          <span class="muted">High-Resolution Source Preview</span>
        </div>
        <div class="lightbox-actions"><button class="btn secondary small" data-action="preview-zoom">${S.previewZoom ? "Fit page" : "Zoom to read"}</button><button class="btn small" data-action="select-preview">Select this page →</button>
          ${pNum > 1 ? `<button class="btn secondary small" data-action="zoom-page" data-page="${pNum - 1}">← Prev</button>` : ""}
          ${pNum < S.document.pageCount ? `<button class="btn secondary small" data-action="zoom-page" data-page="${pNum + 1}">Next →</button>` : ""}
          <button class="btn secondary small" data-action="close-lightbox">✕ Close</button>
        </div>
      </div>
      <div class="lightbox-body ${S.previewZoom ? "zoomed" : ""}">
        <img src="${imgUrl}" alt="Page ${pNum} Full Preview" class="lightbox-image">
      </div>
    </div>
  </div>`;
}
function render() {
  const page =
    !S.signedIn || S.intro
      ? login()
      : shell(
          S.view === "judge"
            ? judgeView(S, helpers)
            : S.view === "home"
              ? workspaceHome(S, helpers)
              : S.view === "upload"
                ? uploadView()
                : !S.paper
                  ? workspaceHome(S, helpers)
                  : S.view === "host"
                    ? hostView(S, helpers)
                    : S.view === "integrations"
                      ? integrationView(S, helpers)
                      : S.view === "retry"
                        ? retryView(S, helpers)
                        : S.view === "review"
                          ? reviewView()
                          : S.view === "export"
                            ? exportView()
                            : S.view === "responses"
                              ? responsesView()
                              : S.view === "results" && S.report
                                ? resultsView()
                                : coachView(),
        );
  $("#app").innerHTML = (page + floatingProgress() + lightboxModal(S, helpers))
    .replaceAll('href="/', 'href="' + BASE + "/")
    .replaceAll('src="/', 'src="' + BASE + "/");
}
const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });
async function upload(file, unused, mode, subject) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) throw new Error("Upload at most 25 MB.");
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const pdfHandle = isPdf ? await openPdf(file, BASE) : null;
  const uri = isPdf ? null : await imagePreview(file);
  S.queue = [];
  S.selection = [];
  S.cursor = 0;
  S.report = null;
  S.responses = [];
  S.pageIndex = 0;
  S.coachIndex = 0;
  S.chat = [];
  S.doubt = "";
  S.responseEvidence = {};
  S.regionBox = null;
  S.lightboxPage = null;
  S.requestCap = 4;
  const pdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const info = pdf
    ? await inspectPdf(pdfHandle, 0, BASE, previewProgress)
    : {
        pageCount: 1,
        offset: 0,
        batchSize: 24,
        previews: [
          {
            sourcePage: 1,
            thumbnail: uri,
            hasVisuals: true,
            nativeTextLength: 0,
          },
        ],
      };
  S.document = {
    ...info,
    name: file.name,
    uri,
    pdf,
    pdfHandle,
    mode,
    subject,
    metadata: {},
  };
  info.previews.forEach((p) => {
    S.document.metadata[p.sourcePage - 1] = p;
  });
  S.paper = await api("/papers", {
    name: file.name.replace(/\.[^.]+$/, ""),
    journey: S.journey,
  });
  S.queueIndex = 0;
  S.message = `Exam loaded (${info.pageCount} pages). Select any one, two or three pages below, then digitize only the page you choose.`;
  S.focusTarget = ".page-browser";
  S.document.hiresPages = {};
  S.document.hiresPages[1] = pdf ? (await renderPdfPage(pdfHandle, 0, true)).image : uri;
  S.lightboxPage = 1;
  S.previewZoom = false;
  S.focusTarget = ".lightbox-container";
}
async function browsePages(offset) {
  const d = S.document;
  const info = await inspectPdf(d.pdfHandle, offset, BASE, previewProgress);
  Object.assign(d, { offset: info.offset, previews: info.previews });
  info.previews.forEach((p) => {
    d.metadata[p.sourcePage - 1] = p;
  });
}
function previewProgress(done, total) {
  S.progress = `Preparing local page previews · ${done}/${total} · no Meta inference`;
  render();
}
function togglePage(index) {
  const selected = S.selection || [];
  if (selected.includes(index))
    S.selection = selected.filter((n) => n !== index);
  else {
    if (selected.length >= 3)
      throw new Error(
        "Choose at most three pages for this judge run. Deselect one first.",
      );
    S.selection = selected.concat(index).sort((a, b) => a - b);
  }
  S.queue = S.selection.map(
    (n) =>
      S.queue.find((p) => p.sourcePage === n + 1) || {
        ...S.document.metadata[n],
        filename: S.document.name,
        pageId: crypto.randomUUID(),
        subject: S.document.subject,
        cleanScan:
          S.document.mode === "photo" ||
          (S.document.mode === "auto" &&
            S.document.metadata[n].nativeTextLength < 80),
      },
  );
  S.cursor = S.queue.filter((p) => p.completed).length;
  S.queueIndex = S.queue.findIndex((p) => !p.completed);
}
async function hydratePage(page) {
  if (page.image) return;
  const d = S.document;
  if (d.pdf) {
    Object.assign(page, await renderPdfPage(d.pdfHandle, page.sourcePage - 1));
  } else Object.assign(page, { image: d.uri, nativeText: "" });
}
async function processPages(cap = 4) {
  const index = S.queueIndex ?? S.queue.findIndex((p) => !p.completed);
  const page = S.queue[index];
  if (!page || page.completed) throw new Error("Select an unprocessed page.");
  await hydratePage(page);
  const textOnly =
    (page.routeOverride || (!page.hasVisuals ? "text" : "visual")) === "text";
  cap = textOnly ? 1 : cap;
  S.progress = `Digitizing only source page ${page.sourcePage}. Maximum ${cap} model requests. Other pages and answer audits will not run automatically.`;
  render();
  S.paper = await infer(`/papers/${S.paper.id}/pages`, {
    ...page,
    recoverLayout: cap === 4,
    textOnly,
  });
  page.completed = true;
  S.cursor = S.queue.filter((p) => p.completed).length;
  S.queueIndex = S.queue.findIndex((p) => !p.completed);
  S.view = "review";
  S.focusTarget = ".source-review";
  S.pageIndex = S.paper.pages.length - 1;
  S.message = `Only source page ${page.sourcePage} was processed. ${S.queue.length - S.cursor} selected pages remain untouched. Verify individual questions only when needed.`;
}
function parseBox(value) {
  if (!value.trim()) return null;
  const box = value.split(",").map(Number);
  if (
    box.length !== 4 ||
    box.some((v) => !Number.isFinite(v) || v < 0 || v > 1000) ||
    box[2] <= box[0] ||
    box[3] <= box[1]
  )
    throw new Error(
      "Crop must be left, top, right, bottom with increasing coordinates between 0 and 1000.",
    );
  return box;
}
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportPdf(format) {
  const value = await api(`/papers/${S.paper.id}/export`, { format });
  const bytes = Uint8Array.from(atob(value.base64), (c) => c.charCodeAt(0));
  download(bytes, `${S.paper.name}-${format}.pdf`, "application/pdf");
  S.message = value.warnings?.length
    ? value.warnings.join(" ")
    : "PDF exported from your uploaded content.";
}
async function omr(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) throw new Error("OMR upload limit: 25 MB.");
  const pdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const image = pdf
    ? (await renderPdfPage(await openPdf(file, BASE), 0)).image
    : await imagePreview(file);
  S.paper = await infer(`/papers/${S.paper.id}/responses`, {
    image,
    cleanScan: true,
  });
  S.message =
    "Response-sheet marks read. Review the matching question rows before using them.";
}
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  if (form.id === "login-form")
    task(async () => {
      const loginPayload = {
        email: data.email || "judge@paperbridge.demo",
        password: data.password || "THXLU6iKGdT4IGLKf0Xs",
      };
      const session = await api("/login", loginPayload);
      S.connectorConfigured = session.connectorConfigured;
      S.signedIn = true;
      S.intro = false;
      S.paper = null;
      S.report = null;
      S.view = location.pathname.endsWith("/judge") ? "judge" : "home";
      await loadLibrary();
      void refreshMetadata();
    }, "Opening your workspace…");
  if (form.classList.contains("edit-form"))
    task(async () => {
      const q = S.paper.questions.find((q) => q.id === form.dataset.id);
      const question = {
        text: data.text,
        sourceNumber: data.sourceNumber,
        topic: data.topic,
        explanation: data.explanation,
        correctIndex:
          data.correctIndex === "" ? null : Number(data.correctIndex),
        diagramBox: parseBox(data.diagramBox),
        sourceBox: parseBox(data.sourceBox),
        options: q.options.map((o, i) => ({
          ...o,
          text: data["option-" + i],
          imageBox: parseBox(data["box-" + i]),
        })),
      };
      S.paper = await api(`/papers/${S.paper.id}/edit`, {
        questionId: q.id,
        question,
      });
      S.report = null;
      S.message = "Edits saved. The old audit has been invalidated.";
    }, "Saving edits and recropping the original pixels…");
  if (form.id === "region-form")
    task(async () => {
      S.paper = await infer(`/papers/${S.paper.id}/recover`, {
        pageIndex: S.pageIndex,
        box: parseBox(data.box),
        sourceNumber: data.sourceNumber,
      });
      S.report = null;
      S.responses = [];
      S.message =
        "The selected source region was extracted with one Spark request. Review it against the source.";
    }, "Extracting only the selected question region · maximum 1 request…");
  if (form.id === "host-selection-form")
    task(async () => {
      S.paper = await api(`/papers/${S.paper.id}/selection`, {
        questionIds: S.paper.questions
          .filter((q) => data["question-" + q.id] === "on")
          .map((q) => q.id),
      });
      S.message =
        "Hosted-test selection saved. Excluded questions remain in your source review.";
    }, "Saving the reviewed subset…");
  if (form.id === "hosting-settings-form")
    task(async () => {
      S.paper = await api(`/papers/${S.paper.id}/settings`, {
        name: data.name,
        marks: Number(data.marks),
        penalty: Number(data.penalty),
        durationMins: Number(data.durationMins),
      });
      S.message = "Test settings saved.";
    }, "Saving settings…");
  if (form.id === "shared-paper-form")
    task(async () => {
      const url = new URL(data.url);
      if (url.origin !== location.origin)
        throw new Error("Use a share link from this PaperBridge portal.");
      const token = url.pathname.split("/").pop();
      S.paper = await api("/hosted/" + token + "/import", {});
      S.responses = [];
      S.responseEvidence = {};
      S.report = null;
      S.chat = [];
      S.coachIndex = 0;
      S.view = "responses";
      S.focusTarget = ".section-head";
      await loadLibrary();
    }, "Opening a private copy of this shared paper…");
  if (form.id === "responses-form")
    task(async () => {
      if (S.paper.questions.some((_, i) => !data["answer-" + i]))
        throw new Error("Choose your answer or explicitly mark Skipped for every question before analysis.");
      const answers = S.paper.questions.map((_, i) =>
        ["", "skip"].includes(data["answer-" + i])
          ? null
          : Number(data["answer-" + i]),
      );
      S.report = await api(`/papers/${S.paper.id}/analyze`, {
        answers,
        confirmed: true,
        responseStates: S.paper.questions.map((_, i) =>
          data["answer-" + i] === "skip"
            ? "SKIPPED"
            : data["answer-" + i] === ""
              ? "UNRESOLVED"
              : "SELECTED",
        ),
      });
      S.responses = answers;
      S.paper = await api(`/papers/${S.paper.id}`);
      S.view = "results";
      S.focusTarget = ".section-head";
    }, "Scoring your confirmed responses…");
  if (form.id === "key-form")
    task(async () => {
      const parts = data.key
        .toUpperCase()
        .split(/[\s,;]+/)
        .filter(Boolean);
      if (parts.some((v) => !/^[A-F]$/.test(v)))
        throw new Error("Use one answer letter per question.");
      S.paper = await api(`/papers/${S.paper.id}/key`, {
        answers: parts.map((v) => v.charCodeAt(0) - 65),
      });
      S.report = null;
      S.message = "Your supplied key is the scoring reference.";
    }, "Applying the supplied key…");
  if (form.id === "marking-form")
    task(async () => {
      S.paper = await api(`/papers/${S.paper.id}/settings`, {
        name: S.paper.name,
        marks: Number(data.marks),
        penalty: Number(data.penalty),
        durationMins: S.paper.durationMins,
      });
      S.report = null;
      S.message = "Marking scheme saved.";
    }, "Saving marking scheme…");
  if (form.id === "coach-form")
    task(async () => {
      const doubt = data.doubt;
      const history = S.chat;
      S.chat.push({ role: "student", text: doubt });
      S.doubt = "";
      const value = await infer(`/papers/${S.paper.id}/coach`, {
        questionId: S.paper.questions[S.coachIndex].id,
        doubt,
        history,
      });
      S.chat.push({ role: "coach", text: value.hint });
    }, "Generating a live guiding question…");
});
document.addEventListener("click", (event) => {
  const sampleBtn = event.target.closest("#load-sample-btn, [data-action='load-sample']");
  if (sampleBtn) {
    if (sampleBtn.disabled || S.busy) return;
    const mode = $("#scan-mode")?.value || "auto";
    const subject = $("#subject")?.value || "Physics";
    task(async () => {
      const response = await fetch(BASE + "/sample-exam.pdf");
      if (!response.ok) throw new Error("Could not load sample exam paper.");
      const blob = await response.blob();
      const file = new File([blob], "NEET-2026-Physics-Real-Exam.pdf", { type: "application/pdf" });
      await upload(file, null, mode, subject);
    }, "Loading sample competitive exam paper into page browser…");
    return;
  }
  const el = event.target.closest("[data-action]");
  if (!el || el.disabled || S.busy) return;
  const a = el.dataset.action;
  if (S.recording && a !== "record") return;
  if (a === "resume-processing") {
    task(resumeProcessing, "Reconnecting to your saved processing job…");
    return;
  }
  if (a === "choose-journey") {
    const role = el.dataset.journey;
    if (!S.signedIn) {
      S.journey = role;
      history.pushState({}, "", BASE + "/" + role);
      render();
      $("#judge-access")?.scrollIntoView({ behavior: "smooth" });
    } else
      task(() => enterJourney(role), "Opening the " + role + " workspace…");
  }
  if (a === "judge") {
    S.view = "judge";
    S.intro = false;
    history.pushState({}, "", BASE + "/judge");
    render();
    window.scrollTo({ top: 0 });
  }
  if (a === "refresh-papers") task(loadLibrary, "Refreshing your papers…");
  if (a === "copy-evidence")
    task(async () => {
      const copy = await api("/papers/from-evidence", { journey: S.journey });
      await openPaper(copy.id);
      await loadLibrary();
      S.message =
        "Copied the actual saved extraction. No new model inference was used. Responses you enter here are for this example.";
    }, "Copying the saved uploaded-page evidence…");
  if (a === "open-paper")
    task(() => openPaper(el.dataset.id), "Opening this paper…");
  if (a === "audit-selected") {
    const ids = Array.from($("#host-selection-form").querySelectorAll('input[type="checkbox"]:checked'))
      .map((field) => field.name.slice("question-".length));
    task(async () => {
      if (!ids.length) throw new Error("Select the questions you want to verify.");
      if (ids.length > 20) throw new Error("Select up to 20 questions for this verification run.");
      S.paper = await api(`/papers/${S.paper.id}/selection`, { questionIds: ids });
      const pending = ids.filter((id) => S.paper.questions.find((q) => q.id === id)?.audit.status !== "VERIFIED");
      for (let offset = 0; offset < pending.length; offset += 3) {
        S.paper = await infer(`/papers/${S.paper.id}/audit-selection`, { questionIds: pending.slice(offset, offset + 3) });
      }
      const unresolved = S.paper.questions.filter((q) => ids.includes(q.id) && q.audit.status !== "VERIFIED").length;
      S.message = unresolved ? `${unresolved} selected questions still need review. Select the verified subset to host now.` : "Selected questions verified. Your test is ready to host.";
    }, "Independently verifying your selected questions…");
  }
  if (a === "approve-all-host")
    task(async () => {
      const ids = S.paper.questions.filter((q) => q.audit.status === "VERIFIED" && q.sourceComplete !== false && Number.isInteger(q.correctIndex)).map((q) => q.id);
      if (!ids.length) throw new Error("Audit at least one question in Review questions first.");
      S.paper = await api(`/papers/${S.paper.id}/selection`, { questionIds: ids });
      S.message = "Verified questions selected. Check your test settings, then host this reviewed subset.";
    }, "Selecting independently verified questions…");
  if (a === "host-paper" || a === "host-unverified") {
    const skipVerification = a === "host-unverified";
    const selection = $("#host-selection-form");
    const settings = $("#hosting-settings-form");
    if (settings && !settings.reportValidity()) return;
    const chosenIds = selection ? Array.from(selection.querySelectorAll('input[type="checkbox"]:checked')).map((field) => field.name.slice(9)) : null;
    const settingsData = settings ? Object.fromEntries(new FormData(settings)) : null;
    task(async () => {
      if (chosenIds) S.paper = await api(`/papers/${S.paper.id}/selection`, { questionIds: chosenIds });
      if (settingsData) S.paper = await api(`/papers/${S.paper.id}/settings`, {
        name: settingsData.name, marks: Number(settingsData.marks), penalty: Number(settingsData.penalty), durationMins: Number(settingsData.durationMins),
      });
      S.paper = await api(`/papers/${S.paper.id}/host`, { skipVerification });
      await loadLibrary();
      S.message = "Test successfully hosted! Share link is ready below.";
      S.focusTarget = ".section-head";
    }, "Hosting the selected questions…");
  }
  if (a === "zoom-page") {
    const pNum = Number(el.dataset.page);
    task(async () => {
      const d = S.document;
      if (!d) return;
      d.hiresPages = d.hiresPages || {};
      if (!d.hiresPages[pNum]) {
        if (d.pdf) {
          const res = await renderPdfPage(d.pdfHandle, pNum - 1, true);
          if (Object.keys(d.hiresPages).length >= 4) delete d.hiresPages[Object.keys(d.hiresPages)[0]];
          d.hiresPages[pNum] = res.image;
        } else {
          d.hiresPages[pNum] = d.uri;
        }
      }
      S.lightboxPage = pNum;
      S.focusTarget = ".lightbox-container";
    }, `Rendering high-resolution Page ${pNum}…`);
    return;
  }
  if (a === "close-lightbox") {
    if (event.target.closest(".lightbox-container") && !el.matches("button")) return;
    S.lightboxPage = null;
    S.compareSource = false;
    render();
    $(S.view === "upload" ? ".page-browser" : ".source-review")?.scrollIntoView({ block: "start", behavior: "instant" });
    return;
  }
  if (a === "preview-zoom") {
    S.previewZoom = !S.previewZoom;
    render();
    return;
  }
  if (a === "compare-zoom") {
    S.compareZoom = !S.compareZoom;
    render();
    return;
  }
  if (a === "compare-source") {
    S.compareSource = true;
    render();
    return;
  }
  if (a === "select-preview") {
    const index = S.lightboxPage - 1;
    task(async () => {
      if (!S.document.metadata[index]) await browsePages(Math.floor(index / 24) * 24);
      if (!S.selection.includes(index)) togglePage(index);
      S.queueIndex = S.queue.findIndex((p) => p.sourcePage === index + 1);
      await hydratePage(S.queue[S.queueIndex]);
      S.lightboxPage = null;
      S.focusTarget = ".selection-workbench";
      S.message = `Page ${index + 1} selected. Click Digitize when ready.`;
    }, "Preparing your chosen page…");
    return;
  }
  if (a === "copy-test-link")
    task(async () => {
      await navigator.clipboard.writeText(
        location.origin + BASE + "/test/" + S.paper.hostToken,
      );
      S.message = "Test link copied.";
    }, "Copying link…");
  if (a === "share-student")
    task(async () => {
      const copy = await api(`/papers/${S.paper.id}/share-student`, {});
      await enterJourney("student", "responses");
      S.paper = copy;
      S.responses = [];
      S.report = null;
      await loadLibrary();
    }, "Creating a private student analysis from the shared paper…");
  if (a === "publish-paper")
    task(async () => {
      S.paper = await api(`/papers/${S.paper.id}/publish`, {});
    }, "Publishing and reading back the real destination receipt…");
  if (a === "check-receipt")
    task(async () => {
      S.paper.publication = await api(`/papers/${S.paper.id}/receipt`);
    }, "Checking the saved destination test…");
  if (a === "start-retry")
    task(async () => {
      const result = await api(`/papers/${S.paper.id}/retry`, {});
      location.assign(BASE + "/retry/" + result.token);
    }, "Preparing a separate retry…");
  if (a === "nav") {
    S.view = el.dataset.view;
    S.error = "";
    S.message = "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (a === "models")
    task(async () => {
      S.models = await api("/models");
    }, "Checking actual model access…");
  if (a === "logout")
    task(async () => {
      await api("/logout", {});
      sessionStorage.removeItem("pb-" + S.journey + "-paper");
      S.signedIn = false;
      for (const role of Object.keys(journeys)) {
        delete roleCache[role];
        sessionStorage.removeItem("pb-" + role + "-paper");
        sessionStorage.removeItem("pb-" + role + "-pending-job");
      }
      Object.assign(S, cleanRole());
      S.intro = true;
      history.replaceState({}, "", BASE + "/");
    }, "Signing out…");
  if (a === "toggle-page") {
    try {
      togglePage(Number(el.dataset.page));
      S.error = "";
    } catch (e) {
      S.error = e.message;
    }
    render();
  }
  if (a === "page-prev")
    task(
      () => browsePages(Math.max(0, S.document.offset - 24)),
      "Loading previous page previews locally…",
    );
  if (a === "page-next")
    task(
      () => browsePages(S.document.offset + 24),
      "Loading next page previews locally…",
    );
  if (a === "preview-page")
    task(
      () => hydratePage(S.queue[S.queueIndex]),
      "Rendering this page locally · no Meta request…",
    );
  if (a === "back-workspace") {
    S.intro = false;
    S.view = "home";
    render();
  }
  if (a === "intro") {
    S.intro = true;
    render();
  }
  if (a === "use-showcase")
    task(async () => {
      await api(`/papers/${S.paper.id}/showcase`, { pageIndex: S.pageIndex });
      S.showcase = await api("/showcase");
      S.intro = true;
    }, "Preparing the introduction from this actual uploaded page · no Meta requests…");
  if (a === "digitize-one") {
    const cap = Number($("#request-cap")?.value || 4);
    task(() => processPages(cap), "Processing only the page you selected…");
  }
  if (a === "audit")
    task(async () => {
      S.paper = await infer(`/papers/${S.paper.id}/audit`, {
        questionId: el.dataset.id,
      });
      S.report = null;
      S.message =
        "Fresh audit results saved. Unconfirmed questions remain flagged.";
    }, "Verifying one selected question · maximum 2 requests…");
  if (a === "select-region") {
    S.cropping = true;
    const area = $("#region-source");
    if (area) {
      area.style.cursor = "crosshair";
      area.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
  if (a === "recover")
    task(async () => {
      S.paper = await infer(`/papers/${S.paper.id}/recover`, {
        pageIndex: S.pageIndex,
      });
    }, "Checking one missing source block · maximum 2 model requests…");
  if (a === "export-clean")
    task(() => exportPdf("clean"), "Creating a clean scan PDF…");
  if (a === "export-typeset")
    task(
      () => exportPdf("typeset"),
      "Typesetting the edited paper and preserving original diagram crops…",
    );
  if (a === "export-json") {
    const { pages, owner, attempts, ...paper } = S.paper;
    download(
      JSON.stringify(
        { ...paper, sourcePages: pages.map(({ image, rawImage, ...p }) => p) },
        null,
        2,
      ),
      S.paper.name + ".json",
      "application/json",
    );
  }
  if (a === "use-marks") {
    S.responseEvidence = {};
    S.responses = S.paper.questions.map((q) => {
      S.responseEvidence[q.id] = q.studentResponse?.evidence || "";
      return q.studentResponse?.confidence >= 0.9 &&
        q.studentResponse.selectedIndex !== null
        ? q.studentResponse.selectedIndex
        : undefined;
    });
    S.message =
      "Detected marks are filled as proposals. Confirm or correct every row before analysis.";
    render();
  }
  if (a === "use-omr") {
    S.responseEvidence = {};
    S.responses = S.paper.questions.map((q) => {
      const rows = S.paper.responseDetections.filter(
        (r) => r.questionId === q.id,
      );
      const row = rows.length === 1 ? rows[0] : null;
      S.responseEvidence[q.id] =
        row?.evidence || "No unique OMR match; enter manually.";
      return row?.selectedIndex ?? undefined;
    });
    S.message =
      "OMR proposals filled. Multiple, uncertain or unmatched marks remain blank.";
    render();
  }
  if (a === "coach-question") {
    S.coachIndex = Number(el.dataset.index);
    S.chat = [];
    S.doubt = "";
    S.view = "coach";
    render();
    $(".section-head")?.scrollIntoView({ block: "start", behavior: "instant" });
  }
  if (a === "speak") {
    if (!window.speechSynthesis) {
      S.error = "Speech playback is not available in this browser.";
      render();
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(
      S.chat[Number(el.dataset.index)].text,
    );
    u.lang = "en-IN";
    speechSynthesis.speak(u);
  }
  if (a === "record") record();
});
document.addEventListener("change", (event) => {
  if (S.busy) return;
  if (event.target.id === "paper-file") {
    const file = event.target.files[0],
      mode = $("#scan-mode").value,
      subject = $("#subject").value;
    task(
      () => upload(file, null, mode, subject),
      "Loading the document and local page thumbnails · no Meta inference…",
    );
  }
  if (event.target.id === "omr-file")
    task(
      () => omr(event.target.files[0]),
      "Reading the actual response sheet with Meta vision…",
    );
  if (event.target.id === "queued-page") {
    S.queueIndex = Number(event.target.value);
    render();
  }
  if (event.target.id === "processing-route") {
    const page = S.queue[S.queueIndex];
    if (page) page.routeOverride = event.target.value;
    render();
  }
  if (event.target.id === "request-cap")
    S.requestCap = Number(event.target.value);
  if (event.target.id === "source-page") {
    S.pageIndex = Number(event.target.value);
    render();
  }
  if (event.target.id === "coach-question") {
    S.coachIndex = Number(event.target.value);
    S.chat = [];
    S.doubt = "";
    render();
  }
  if (event.target.closest("#host-selection-form")) {
    const ids = Array.from($("#host-selection-form").querySelectorAll('input[type="checkbox"]:checked')).map((field) => field.name.slice(9));
    const selected = S.paper.questions.filter((q) => ids.includes(q.id));
    const canHost = selected.length > 0 && selected.every(hasUsableKey);
    const ready = canHost && selected.every(isVerifiedForHosting);
    const hostButton = $('[data-action="host-paper"]');
    if (hostButton) hostButton.disabled = !ready;
    const unverifiedButton = $('[data-action="host-unverified"]');
    if (unverifiedButton) unverifiedButton.disabled = !canHost || ready;
    const keyHint = $("#hosting-key-hint");
    if (keyHint) keyHint.hidden = canHost;
  }
  if (event.target.name?.startsWith("answer-"))
    S.responses[Number(event.target.name.slice(7))] =
      event.target.value === ""
        ? undefined
        : event.target.value === "skip"
          ? null
          : Number(event.target.value);
});
document.addEventListener("input", (event) => {
  if (event.target.id === "doubt") S.doubt = event.target.value;
});
let recorder, stream, recordTimeout;
async function record() {
  if (S.recording) {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    S.error =
      "Use HTTPS/localhost and a supported browser for recording, or type your doubt.";
    render();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      clearTimeout(recordTimeout);
      stream.getTracks().forEach((t) => t.stop());
      S.recording = false;
      await task(async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const ctx = new AudioContext();
        let decoded;
        try {
          decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        } finally {
          await ctx.close();
        }
        const offline = new OfflineAudioContext(
          1,
          Math.ceil(decoded.duration * 24000),
          24000,
        );
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        const pcm = (await offline.startRendering()).getChannelData(0);
        const buffer = new ArrayBuffer(44 + pcm.length * 2),
          view = new DataView(buffer);
        const text = (offset, value) =>
          [...value].forEach((c, i) =>
            view.setUint8(offset + i, c.charCodeAt(0)),
          );
        text(0, "RIFF");
        view.setUint32(4, 36 + pcm.length * 2, true);
        text(8, "WAVE");
        text(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, 24000, true);
        view.setUint32(28, 48000, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, "data");
        view.setUint32(40, pcm.length * 2, true);
        pcm.forEach((v, i) =>
          view.setInt16(
            44 + i * 2,
            Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767),
            true,
          ),
        );
        const uri = await readFile(new Blob([buffer], { type: "audio/wav" }));
        S.doubt = (
          await infer(`/papers/${S.paper.id}/voice`, {
            audioBase64: uri.split(",")[1],
          })
        ).transcript;
        S.message =
          "Your actual speech was transcribed. Review it before sending.";
      }, "Transcribing your actual recording…");
    };
    recorder.start();
    S.recording = true;
    render();
    recordTimeout = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 30000);
  } catch {
    stream?.getTracks().forEach((t) => t.stop());
    S.recording = false;
    S.error =
      "Microphone access was denied or recording could not start. Type your doubt instead.";
    render();
  }
}
window.addEventListener("pagehide", () => {
  if (recorder?.state === "recording") recorder.stop();
  stream?.getTracks().forEach((t) => t.stop());
});
async function init() {
  const path = location.pathname.slice(BASE.length);
  const assessment = path.match(/^\/(test|t|retry)\/(.+)$/);
  if (assessment) {
    await mountAssessment({
      token: assessment[2],
      retry: assessment[1] === "retry",
      BASE,
      esc,
      math,
      img,
    });
    return;
  }
  S.intro = path === "/" || path === "";
  render();
  // The Python export preview can be slow on a cold start. Never gate login on it.
  void api("/showcase").then((value) => {
    S.showcase = value;
    renderWhenIdle();
  }).catch(() => {});
  try {
    const searchParams = new URLSearchParams(location.search);
    const demoMode = searchParams.get("demo");
    if (demoMode) {
      if (demoMode === "student") S.journey = "student";
      if (demoMode === "upload") S.view = "upload";
      if (demoMode === "judge") S.view = "judge";
      if (demoMode === "workspace") S.view = "home";
      try {
        const loginRes = await api("/login", {
          email: "judge@paperbridge.demo",
          password: "THXLU6iKGdT4IGLKf0Xs",
        });
        if (loginRes) {
          S.signedIn = true;
          S.intro = false;
          S.connectorConfigured = loginRes.connectorConfigured;
        }
      } catch (error) { S.error = error.message; }
    } else {
      const session = await api("/session").catch(() => null);
      if (session) {
        S.signedIn = true;
        S.connectorConfigured = session.connectorConfigured;
      }
      S.intro = path === "/";
      S.view = path === "/judge" ? "judge" : "home";
    }
    render();
    if (!S.signedIn) return;
    const id = sessionStorage.getItem("pb-" + S.journey + "-paper");
    if (id) {
      try {
        const view = S.view;
        await openPaper(id, false);
        S.view = view;
      } catch {
        sessionStorage.removeItem("pb-" + S.journey + "-paper");
      }
    }
    await loadLibrary();
    render();
    void refreshMetadata();
    if (sessionStorage.getItem("pb-" + S.journey + "-pending-job"))
      await task(resumeProcessing, "Restoring saved processing progress…");
  } catch (error) { S.error = error.message; }
  render();
}

init();
window.addEventListener("popstate", () => location.reload());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (S.lightboxPage || S.compareSource)) {
    S.lightboxPage = null;
    S.compareSource = false;
    render();
  }
});

let cropDrag = null;
const cropPoint = (event, area) => {
  const rect = area.getBoundingClientRect();
  return [
    Math.max(
      0,
      Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000),
    ),
    Math.max(
      0,
      Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000),
    ),
  ];
};
document.addEventListener("pointerdown", (event) => {
  const area = event.target.closest("#region-source");
  if (!S.cropping || !area) return;
  event.preventDefault();
  area.setPointerCapture(event.pointerId);
  const overlay = document.createElement("div");
  overlay.className = "bounding-box crop-selection";
  area.append(overlay);
  cropDrag = { area, start: cropPoint(event, area), overlay };
});
document.addEventListener("pointermove", (event) => {
  if (!cropDrag) return;
  const end = cropPoint(event, cropDrag.area),
    start = cropDrag.start;
  const box = [
    Math.min(start[0], end[0]),
    Math.min(start[1], end[1]),
    Math.max(start[0], end[0]),
    Math.max(start[1], end[1]),
  ];
  Object.assign(cropDrag.overlay.style, {
    left: box[0] / 10 + "%",
    top: box[1] / 10 + "%",
    width: (box[2] - box[0]) / 10 + "%",
    height: (box[3] - box[1]) / 10 + "%",
  });
});
document.addEventListener("pointerup", (event) => {
  if (!cropDrag) return;
  const end = cropPoint(event, cropDrag.area),
    start = cropDrag.start;
  S.regionBox = [
    Math.min(start[0], end[0]),
    Math.min(start[1], end[1]),
    Math.max(start[0], end[0]),
    Math.max(start[1], end[1]),
  ].map(Math.round);
  const field = $("#manual-region-box");
  if (field) field.value = S.regionBox.join(", ");
  S.cropping = false;
  cropDrag.area.style.cursor = "default";
  cropDrag = null;
});

export async function mountAssessment({ token, retry, BASE, esc, math, img }) {
  const root = document.querySelector("#app");
  const endpoint =
    BASE +
    "/api/" +
    (retry ? "retries/" : "hosted/") +
    encodeURIComponent(token);
  const s = {
    paper: null,
    started: false,
    index: 0,
    answers: [],
    flagged: [],
    error: "",
    busy: false,
    report: null,
  };
  let timer;
  const storageKey = "pb-assessment:" + (retry ? "retry:" : "host:") + token;
  function saveProgress() {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({
        attemptToken: s.attemptToken, startedAt: s.startedAt,
        answers: s.answers, flagged: s.flagged, index: s.index, report: s.report,
      }));
    } catch { /* The test still works if browser storage is unavailable. */ }
  }
  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => {
      const clockEl = root.querySelector(".exam-clock");
      if (clockEl) clockEl.textContent = clock();
      if (remaining() === 0 && !s.busy) {
        clearInterval(timer);
        void submit(true);
      }
    }, 1000);
  }
  async function request(action = "", data) {
    const r = await fetch(endpoint + action, {
      method: data === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error || "Assessment request failed.");
    return value;
  }
  function remaining() {
    return Math.max(
      0,
      Math.ceil(
        (s.startedAt + s.paper.durationMins * 60000 - Date.now()) / 1000,
      ),
    );
  }
  function clock() {
    const n = remaining();
    return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  }
  function render() {
    root.innerHTML = `<div class="assessment"><header class="assessment-header"><a class="brand" href="${BASE}/"><img src="${BASE}/assets/icon.svg" alt="">PaperBridge</a><span class="pill">${retry ? "Separate retry" : "Hosted assessment"}</span>${s.started && !s.report ? `<strong class="exam-clock" aria-label="Time remaining">${clock()}</strong>` : ""}</header><main>${s.error ? `<div role="alert" class="notice error">${esc(s.error)}</div>` : ""}${!s.paper ? '<p class="loading">Opening the assessment…</p>' : s.report ? resultView() : !s.started ? `<section class="card exam-start"><div class="eyebrow muted">${retry ? "Your original attempt stays saved" : s.paper.hostedWithoutVerification ? "Hosted without independent verification" : "Reviewed paper · Independent test hosting"}</div><h1>${esc(s.paper.name)}</h1><p>${s.paper.questions.length} questions · ${s.paper.durationMins} minutes · +${s.paper.marks} correct / −${s.paper.penalty} wrong / 0 skipped</p><p class="small muted">${esc(s.paper.keyLabel)}. ${retry ? "This timer measures your new attempt only." : "Your selections are graded on the server after submission."}</p><button class="btn" data-exam="start" ${s.busy ? "disabled" : ""}>Start ${retry ? "retry" : "test"} →</button></section>` : examView()}</main></div>`;
  }
  function examView() {
    const q = s.paper.questions[s.index];
    return `<div class="exam-layout"><section class="card"><div class="spread"><span class="eyebrow muted">Question ${s.index + 1} of ${s.paper.questions.length}</span><span class="pill">+${s.paper.marks} / −${s.paper.penalty}</span></div><div class="question-text" style="margin-top:24px">${math(q.text)}</div>${img(q.imageUrl, "Question source diagram")}<div class="exam-options">${q.options.map((o, i) => `<button data-exam="answer" data-option="${i}" class="exam-option ${s.answers[s.index] === i ? "selected" : ""}" aria-pressed="${s.answers[s.index] === i}" ${s.busy ? "disabled" : ""}><span class="option-label">${String.fromCharCode(65 + i)}</span><span>${math(o.text)}${img(o.imageUrl, "Option " + String.fromCharCode(65 + i) + " source visual", "waveform")}</span></button>`).join("")}</div><div class="action-bar"><div class="stack"><button class="btn secondary" data-exam="clear" ${s.busy ? "disabled" : ""}>Clear response</button><button class="btn secondary" data-exam="flag" ${s.busy ? "disabled" : ""}>${s.flagged.includes(s.index) ? "Unmark review" : "Mark for review"}</button></div><div class="stack"><button class="btn secondary" data-exam="previous" ${s.index === 0 || s.busy ? "disabled" : ""}>← Previous</button><button class="btn" data-exam="next" ${s.index === s.paper.questions.length - 1 || s.busy ? "disabled" : ""}>Next →</button></div></div></section><aside class="card"><h3>Question palette</h3><div class="exam-palette">${s.paper.questions.map((_, i) => `<button data-exam="jump" data-index="${i}" aria-label="Go to question ${i + 1}" class="${s.index === i ? "current" : ""} ${s.answers[i] !== null ? "answered" : ""} ${s.flagged.includes(i) ? "flagged" : ""}">${i + 1}</button>`).join("")}</div><p class="small muted">${s.answers.filter((v) => v !== null).length} answered · ${s.answers.filter((v) => v === null).length} unanswered</p><label class="exam-confirm"><input type="checkbox" id="exam-confirm"> I am ready to submit this attempt.</label><button class="btn" data-exam="submit" ${s.busy ? "disabled" : ""}>Submit attempt →</button></aside></div>`;
  }
  function resultView() {
    const r = s.report;
    return `<section class="section-head"><div class="eyebrow muted">${retry ? "Retry result" : "Submitted attempt"}</div><h1>${r.score} <span class="muted">/ ${r.maxScore}</span></h1><p>${esc(r.scopeLabel || `${r.review.length} questions in this assessment`)}</p><p class="small muted">${esc(r.keyLabel)} · ${r.elapsedSeconds ?? 0} seconds in this digital attempt</p><p>${r.correct} correct · ${r.incorrect} incorrect · ${r.unattempted} skipped</p><a class="btn secondary" href="${BASE}/student">Open student workspace →</a></section>${r.review.map((q, i) => `<article class="card question-card"><div class="spread"><span class="eyebrow muted">Question ${i + 1}</span><span class="pill ${q.status === "CORRECT" ? "good" : "warn"}">${esc(q.status)} · ${q.marks}</span></div><p class="question-text">${math(q.text)}</p>${img(q.imageUrl, "Question diagram")}<p class="small">Your answer: ${q.answer === null ? "Skipped" : String.fromCharCode(65 + q.answer)} · Key: ${String.fromCharCode(65 + q.correctIndex)}</p>${q.options.map((o, i) => `<div class="option ${i === q.correctIndex ? "correct" : ""}"><span class="option-letter">${String.fromCharCode(65 + i)}</span><div>${math(o.text)}${img(o.imageUrl, "Option source visual", "waveform")}</div></div>`).join("")}<details class="audit"><summary>Review the reasoning</summary><p>${math(q.explanation)}</p></details></article>`).join("")}`;
  }
  async function submit(auto = false) {
    if (s.busy || s.report) return;
    if (!auto && !root.querySelector("#exam-confirm")?.checked) {
      s.error = "Confirm you are ready to submit, or continue your attempt.";
      render();
      return;
    }
    s.busy = true;
    s.error = "";
    render();
    try {
      s.report = await request("/submit", {
        attemptToken: s.attemptToken,
        answers: s.answers,
      });
      clearInterval(timer);
      saveProgress();
    } catch (e) {
      s.error = e.message;
    } finally {
      s.busy = false;
      render();
    }
  }
  root.addEventListener("click", async (event) => {
    const el = event.target.closest("[data-exam]");
    if (!el || el.disabled || s.busy) return;
    const a = el.dataset.exam;
    if (a === "start") {
      s.busy = true;
      s.error = "";
      render();
      try {
        const started = await request("/start", {});
        Object.assign(s, started);
        s.started = true;
        saveProgress();
        startTimer();
      } catch (e) {
        s.error = e.message;
      } finally {
        s.busy = false;
        render();
      }
      return;
    }
    if (a === "submit") {
      await submit();
      return;
    }
    if (a === "answer") s.answers[s.index] = Number(el.dataset.option);
    if (a === "clear") s.answers[s.index] = null;
    if (a === "flag")
      s.flagged = s.flagged.includes(s.index)
        ? s.flagged.filter((i) => i !== s.index)
        : s.flagged.concat(s.index);
    if (a === "jump") s.index = Number(el.dataset.index);
    if (a === "next") s.index++;
    if (a === "previous") s.index--;
    s.error = "";
    saveProgress();
    render();
  });
  render();
  try {
    s.paper = await request();
    s.answers = s.paper.questions.map(() => null);
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
    if (saved?.attemptToken && Number.isFinite(saved.startedAt) &&
        Array.isArray(saved.answers) && saved.answers.length === s.paper.questions.length) {
      s.attemptToken = saved.attemptToken;
      s.startedAt = saved.startedAt;
      s.answers = saved.answers.map((answer, i) => Number.isInteger(answer) && answer >= 0 && answer < s.paper.questions[i].options.length ? answer : null);
      s.flagged = Array.isArray(saved.flagged) ? saved.flagged.filter((i) => Number.isInteger(i) && i >= 0 && i < s.paper.questions.length) : [];
      s.index = Math.max(0, Math.min(Number(saved.index) || 0, s.paper.questions.length - 1));
      s.started = true;
      s.report = saved.report || null;
      if (!s.report) startTimer();
    }
  } catch (e) {
    s.error = e.message;
  }
  render();
  window.addEventListener("pagehide", () => clearInterval(timer), {
    once: true,
  });
}

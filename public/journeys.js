export const journeys = {
  organization: {
    label: "Organization",
    title: "Create a digital test.",
    description:
      "Turn a paper into editable questions, a hosted assessment and a platform-ready publication.",
    action: "Create a digital test",
    views: [
      ["home", "01", "My papers"],
      ["upload", "02", "Upload & digitize"],
      ["review", "03", "Review questions"],
      ["host", "04", "Host a test"],
      ["export", "05", "Export paper"],
      ["integrations", "06", "Publish through API"],
    ],
  },
  student: {
    label: "Student",
    title: "Understand your actual attempt.",
    description:
      "Bring the paper you already attempted, confirm your responses and find the next thing to work on.",
    action: "Analyze my exam paper",
    views: [
      ["home", "01", "My papers"],
      ["upload", "02", "Upload my paper"],
      ["review", "03", "Check digitization"],
      ["responses", "04", "My original responses"],
      ["results", "05", "My analysis"],
      ["coach", "06", "Ask my coach"],
      ["retry", "07", "Retry these questions"],
    ],
  },
};
export function journeyChoices(state, { button }) {
  return `<section class="journey-choices" aria-label="Choose your workspace">${Object.entries(
    journeys,
  )
    .map(
      ([id, j]) =>
        `<article class="journey-choice ${state.journey === id ? "chosen" : ""}"><span class="eyebrow muted">For ${id === "student" ? "students" : "organizations"}</span><h2>${j.title}</h2><p>${j.description}</p>${button("choose-journey", j.action + " →", id === "student", `data-journey="${id}"`)}</article>`,
    )
    .join("")}</section>`;
}
export function workspaceHome(state, { esc, button }) {
  const j = journeys[state.journey];
  return `<section class="section-head"><div class="eyebrow muted">${j.label} workspace</div><h1>${j.title}</h1><p>${j.description}</p>${button("nav", j.action + " →", false, 'data-view="upload"')}</section>${state.showcase?.available ? `<section class="card" style="margin-bottom:22px"><span class="eyebrow muted">Try the actual saved extraction · no new inference</span><h3>Explore the folded-paper example.</h3><p class="small muted">Copy ${state.showcase.questionCount} questions from the real uploaded page shown in the introduction. Existing audit results stay visible. Entered responses describe your practice with this example.</p>${button("copy-evidence", "Explore this uploaded example →", true)}</section>` : ""}<section class="card"><div class="spread"><h3>${state.journey === "student" ? "Your private papers" : "Your organization papers"}</h3>${button("refresh-papers", "Refresh", true)}</div>${state.library?.length ? `<div class="paper-library">${state.library.map((p) => `<button class="library-row" data-action="open-paper" data-id="${esc(p.id)}"><span><strong>${esc(p.name)}</strong><small>${p.questionCount} questions · ${p.pageCount} processed pages</small></span><span class="pill">${p.analyzed ? "Original attempt saved" : p.hosted ? "Hosted" : "Draft"}</span><span aria-hidden="true">↗</span></button>`).join("")}</div>` : `<p class="muted">Your workspace starts with your own paper. Load a PDF, browse every page and choose up to three for this judge run.</p>`}</section>${state.journey === "student" ? `<section class="card" style="margin-top:22px"><h3>Already have a PaperBridge test link?</h3><p class="small muted">Import an explicitly shared paper into a private analysis. The original test and other students' responses stay unchanged.</p><form id="shared-paper-form" class="fields"><label>Shared test URL<input name="url" type="url" placeholder="https://…/test/…" required></label><button class="btn secondary">Use this paper for my analysis →</button></form></section>` : ""}`;
}
export function hostView(state, { esc, button }) {
  const p = state.paper,
    selected = p.questions.filter(
      (q) => !p.selectedQuestionIds || p.selectedQuestionIds.includes(q.id),
    ),
    pending = selected.filter((q) => q.audit.status !== "VERIFIED"),
    ready = selected.length > 0 && !pending.length;
  const url = p.hostToken
    ? location.origin +
      (document.querySelector('meta[name="app-base"]')?.content || "") +
      "/test/" +
      p.hostToken
    : null;
  return `<section class="section-head"><div class="eyebrow muted">Organization / Host</div><h2>A reviewed paper. A working test.</h2><p>Hosting freezes this paper version so every student receives the same questions and marking scheme.</p></section><section class="card"><h3>${esc(p.name)}</h3><div class="proof-metrics"><div><strong>${p.questions.length}</strong><span>extracted questions</span></div><div><strong>${selected.length - pending.length}</strong><span>independent checks passed</span></div><div><strong>${pending.length}</strong><span>checks unresolved</span></div></div>${url ? `<div class="notice"><strong>Your test is hosted.</strong> The share link contains no answer key.</div><label class="fields">Share link<input readonly value="${esc(url)}"></label><div class="stack" style="margin-top:18px"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open hosted test ↗</a>${button("copy-test-link", "Copy link", true)}${button("share-student", "Analyze this shared paper as a student →", true)}</div>` : `<p class="small muted">${ready ? "Every selected question has a complete agreeing audit. Confirm the test settings and host when ready." : "Resolve missing keys, source issues and pending audits in Review questions. Verification stays under your control."}</p><form id="host-selection-form" class="fields"><h3>Choose the questions to host</h3><p class="small muted">You can host a reviewed subset. Leave incomplete or unaudited questions out of this test.</p>${p.questions.map((q) => `<label class="host-question-choice"><input type="checkbox" name="question-${esc(q.id)}" ${selected.some((v) => v.id === q.id) ? "checked" : ""}><span>Q${esc(q.sourceNumber || p.questions.indexOf(q) + 1)} · ${esc(q.topic)}</span><span class="pill ${q.audit.status === "VERIFIED" ? "good" : "warn"}">${esc(q.audit.status.toLowerCase().replaceAll("_", " "))}</span></label>`).join("")}<button class="btn secondary">Save test selection</button></form><hr class="section-divider"><form id="hosting-settings-form" class="fields"><label>Test name<input name="name" value="${esc(p.name)}" required maxlength="200"></label><div class="settings-grid"><label>Duration (minutes)<input name="durationMins" type="number" min="1" max="360" value="${p.durationMins}" required></label><label>Marks / correct<select name="marks">${[1, 2, 4].map((n) => `<option ${p.marks === n ? "selected" : ""}>${n}</option>`).join("")}</select></label><label>Penalty / wrong<select name="penalty">${[0, 0.25, 0.5, 1].map((n) => `<option ${p.penalty === n ? "selected" : ""}>${n}</option>`).join("")}</select></label></div><button class="btn secondary">Save test settings</button></form><div class="action-bar">${button("nav", "Review unresolved questions", true, 'data-view="review"')}${button("host-paper", "Host this reviewed paper →", false, ready ? "" : "disabled")}</div>`}</section>`;
}
export function integrationView(state, { esc, button }) {
  const destinationUrl = (() => {
    try {
      const u = new URL(state.paper.publication?.studentLibraryUrl);
      return ["https:", "http:"].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  })();
  const r = state.paper.publication,
    selected = state.paper.questions.filter(
      (q) =>
        !state.paper.selectedQuestionIds ||
        state.paper.selectedQuestionIds.includes(q.id),
    ),
    ready =
      selected.length && selected.every((q) => q.audit.status === "VERIFIED");
  return `<section class="section-head"><div class="eyebrow muted">Organization / Platform connection</div><h2>Publish through a real API.</h2><p>Your reviewed paper can be sent to a configured platform such as ClarifyCue. A successful publication includes an independently fetched destination receipt.</p></section><section class="card"><h3>ClarifyCue connector</h3><span class="pill ${state.connectorConfigured ? "good" : "warn"}">${state.connectorConfigured ? "Configured" : "Not configured"}</span><p class="small muted" style="margin-top:18px">${state.connectorConfigured ? "The connection uses a server-side service credential. Publication and read-back must both succeed." : "The destination service has not been connected. Your independent PaperBridge hosted test remains available from Host a test."}</p>${r ? `<dl class="receipt"><dt>Destination test ID</dt><dd>${esc(r.testId)}</dd><dt>Status</dt><dd>${r.isPublished ? "Published" : "Draft"}</dd><dt>Questions</dt><dd>${r.questionCount}</dd><dt>Read-back verified</dt><dd>${esc(r.readBackVerifiedAt || "Not verified")}</dd></dl>${button("check-receipt", "Check persisted receipt", true)}${destinationUrl ? ` <a class="btn secondary" href="${esc(destinationUrl)}" target="_blank" rel="noopener">Open destination platform ↗</a>` : ""}` : button("publish-paper", "Publish reviewed paper to ClarifyCue →", false, state.connectorConfigured && ready ? "" : "disabled")}<p class="small muted" style="margin-top:18px">Opening an authenticated destination page uses that platform's normal login.</p></section>`;
}
export function retryView(state, { button }) {
  return `<section class="section-head"><div class="eyebrow muted">Student / Fresh attempt</div><h2>Try the questions again.</h2><p>A retry records a new timed attempt. Your saved responses from the original exam remain unchanged.</p></section><section class="card"><h3>${state.paper.questions.length} digitized questions</h3><p class="small muted">Use this to check your reasoning after reviewing a mistake. The timer measures this retry only. Scoring uses this paper's supplied or estimated answer key.</p>${button("start-retry", "Start a separate retry →")}</section>`;
}
export function judgeView(state, helpers) {
  const { button } = helpers;
  return `<section class="section-head"><div class="eyebrow muted">Judge walkthrough / One login</div><h1>One paper. Two useful outcomes.</h1><p>Explore the organization workflow, then the student's actual attempt. Every live action shows its request limit before it runs.</p></section>${journeyChoices(state, helpers)}<section class="card"><ol class="judge-steps"><li><strong>Inspect the transformation.</strong> Open the introduction to compare the actual folded source and digitized output.</li><li><strong>Try a chosen page.</strong> Browse your PDF without inference, select at most three pages and digitize one.</li><li><strong>Check the hard visual.</strong> Inspect circuit polarity, original crops and waveform choices; request an individual Wonder audit.</li><li><strong>Host the reviewed paper.</strong> Open its working test link and inspect a genuine platform receipt when configured.</li><li><strong>Explore student impact.</strong> Enter actual responses, review marks lost and ask a typed or spoken doubt.</li></ol>${button("intro", "See actual before / after evidence ↗", true)}</section>`;
}

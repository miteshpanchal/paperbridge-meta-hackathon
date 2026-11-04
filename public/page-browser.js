export function pageBrowser(state, { esc, img, button }) {
  const doc = state.document;
  if (!doc) return "";
  const selected = state.selection || [];
  const pending = state.queue
    .map((p, i) => ({ p, i }))
    .filter((x) => !x.p.completed);
  const chosen = pending.find((x) => x.i === state.queueIndex) || pending[0];
  if (chosen) state.queueIndex = chosen.i;
  const page = chosen?.p;
  const textRoute = page
    ? (page.routeOverride || (!page.hasVisuals ? "text" : "visual")) === "text"
    : false;
  const offset = doc.offset || 0,
    last = Math.min(offset + doc.batchSize, doc.pageCount);
  return `<section class="card page-browser" style="margin-top:24px"><div class="spread"><div><h3>${esc(doc.name)}</h3><p class="small muted">All ${doc.pageCount} pages are available. Select up to three from anywhere in the PDF. Previewing and selecting use no Meta inference.</p></div><span class="pill">${selected.length}/3 selected</span></div><div class="page-grid">${doc.previews
    .map((p) => {
      const index = p.sourcePage - 1,
        checked = selected.includes(index),
        processed = state.queue.some(
          (q) => q.sourcePage === p.sourcePage && q.completed,
        );
      return `<button class="page-tile ${checked ? "selected" : ""}" data-action="toggle-page" data-page="${index}" role="checkbox" aria-checked="${checked}" aria-label="Select page ${p.sourcePage}" ${state.busy || processed ? "disabled" : ""}>${img(p.thumbnail, "PDF page " + p.sourcePage, "page-thumbnail")}<span class="page-tile-label"><strong>Page ${p.sourcePage}</strong><span>${processed ? "Processed" : checked ? "Selected" : p.hasVisuals ? "Visual / scan" : "Text-dominant"}</span></span></button>`;
    })
    .join(
      "",
    )}</div><div class="spread" style="margin-top:18px">${button("page-prev", "← Previous pages", true, offset === 0 ? "disabled" : "")}<span class="small muted">Pages ${offset + 1}–${last} of ${doc.pageCount}</span>${button("page-next", "Next pages →", true, last >= doc.pageCount ? "disabled" : "")}</div>${page ? `<div class="selection-workbench"><div>${img(page.image || page.thumbnail, "Chosen source page", "source-question")}${!page.image ? button("preview-page", "Open full-size preview · local only", true) : ""}</div><div class="fields"><div class="eyebrow muted">Process one of your selected pages</div><label>Selected page<select id="queued-page">${pending.map(({ p, i }) => `<option value="${i}" ${i === chosen.i ? "selected" : ""}>Page ${p.sourcePage}</option>`).join("")}</select></label><label>Processing route<select id="processing-route"><option value="text" ${textRoute ? "selected" : ""}>Text only · Spark · maximum 1 request</option><option value="visual" ${!textRoute ? "selected" : ""}>Diagrams / photographed page · visual path</option></select></label>${textRoute ? '<div class="notice info small">Uses Muse Spark for extraction. SAM and Wonder are skipped. You can request a Wonder check on an individual question afterward.</div>' : `<label>Visual request cap<select id="request-cap"><option value="4" ${state.requestCap !== 2 ? "selected" : ""}>Focused · at most 4 requests</option><option value="2" ${state.requestCap === 2 ? "selected" : ""}>Economy · at most 2 requests</option></select></label><p class="small muted">Economy: one SAM request + one Spark extraction. Focused can also inspect layout and recover one missing block. Wonder audits stay separate.</p>`}<strong class="small">This click processes only page ${page.sourcePage}. Maximum ${textRoute ? 1 : state.requestCap || 4} model requests.</strong>${button("digitize-one", "Digitize page " + page.sourcePage + " only →")}<p class="small muted">Other selected pages remain untouched until you choose them. Processed selections are retained to avoid repeated charges.</p></div></div>` : selected.length ? '<div class="notice" style="margin-top:18px">Your selected pages have been processed. Open Review & edit to inspect the results.</div>' : '<div class="notice info" style="margin-top:18px">Select any one, two or three pages above. Nothing will be digitized until you click the processing button.</div>'}</section>`;
}

# Judge walkthrough — use an actual paper

1. Sign in using the private submission credentials. Choose Organization or Student. Both workspaces start with your own uploads and remain separate.
2. In the Organization workspace, load the whole PDF locally and browse any page. Select or deselect up to three pages for the judge run. Digital and photographed PDFs can be different papers; compare extraction to each paper's own source, not to one another.
3. Choose one selected page to digitize. Text-only routing uses one Spark request; visual routing has a two- or four-request cap. Other pages do not start automatically. For a photograph, choose photographed mode or auto-detection. Compare original and processed pages, diagrams and option crops.
4. Open the editor for an extracted question. Change text or a crop boundary, save, and observe that the previous audit is invalidated. Verify one selected question with Wonder only when needed (maximum two requests). If a question was missed, select its complete region on the source image for one Spark recovery request.
5. Open Host a test, select a reviewed subset and save the selection. Host it in one click and open its working assessment link. API publication is a distinct action under Publish through API; inspect a genuine receipt when configured.
6. Export both the clean scan PDF and the digitized question paper. Inspect formulas and visuals. Structured JSON preserves editable content and provenance.
7. Switch to Student, upload the paper you actually attempted, or explicitly copy your hosted organization paper into a private student analysis. Open My original responses. Review actual detected marks, enter the student's selections, or upload their OMR. Confirm uncertain/multiple/unmatched responses manually. Supply a key if one is available; AI-derived scores stay labelled as estimates.
8. Analyze the confirmed responses. The score covers only the digitized questions. Start a separate retry to preserve the original exam result. Inspect topic gaps and misconception tags, then ask a typed or recorded doubt about that actual question.

No question, response selection, transcript or success result is supplied as a demonstration fixture. Model errors remain errors. Missing marks are not inferred from the answer key. A failed or disagreeing audit is visible rather than silently presented as verified.

The model-role cards are at the top, immediately visible. The introduction's before/after proof is generated from a real processed upload. Publishing an introduction preview deliberately makes that selected page visible to judges; it is not bundled as example data in the repository.

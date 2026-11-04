# Two journeys, one document engine

PaperBridge is independent of ClarifyCue. A judge signs in once and can switch between the Organization and Student workspaces. The server checks each paper's workspace as well as its session ownership.

| Organization | Student |
| --- | --- |
| Create and digitize an organization paper | Upload a paper already attempted |
| Review source diagrams and graphical choices | Check digitization before scoring |
| Request selected independent audits | Confirm actual responses or OMR proposals |
| Select a reviewed subset and host a stable test | Save an immutable original-attempt result |
| Export or publish through a configured API | Explore marks lost and ask a real doubt |
| Explicitly share the reviewed test | Start a separately recorded timed retry |

`/organization` and `/student` have distinct navigation and paper libraries. `/judge` explains the connected demonstration. `/test/:token` opens the independently hosted CBT. `/retry/:token` opens a private student retry.

An organization paper cannot be scored as a student's original attempt. A student paper cannot publish organization tests. Copying a hosted paper into the student workspace creates a private record, clears response proposals and preserves the original publication. A supplied shared-test link permits that copy without rerunning extraction.

Unknown responses remain unresolved. Students must explicitly choose an answer or confirm that they skipped each question. Scores identify their processed-question denominator and key provenance. The original report is saved independently; retries cannot replace it. Only a new timed digital attempt provides measured response time.

Hosting uses the selected questions, all of which must have complete agreeing independent audits. Incomplete questions can stay in the source review without blocking a reviewed subset. Hosted content is locked. Answer keys and explanations are excluded from the pre-submission CBT payload and grading runs on the server.

PDF previews and selected-page rasterization use PDF.js in the browser. Loading the PDF, browsing pages and selecting up to three pages do not send it to Meta. Only explicit processing sends a chosen page/region or recorded doubt. The two provided PDF formats are different papers, not matching copies.

Long inference actions create persisted processing jobs. A reload polls the existing job instead of launching another model call. Cloud Run requires Cloud Tasks, authenticated Google OIDC delivery and private Cloud Storage. A worker claim is persisted before inference; interrupted work is reported and is not automatically repeated. A paper has one active processing job, preventing edits or competing operations during extraction.

The model allowance is durable across container restarts and shared across both journeys. Input token checks precede text generation; output-token limits bound each response. The ledger reserves against configured Standard-mode prices and records returned usage. Missing usage or uncertain failures keep the reservation. These controls supplement per-action request caps; the provider's billing statement remains authoritative.

Meta input-token checks perform tokenization rather than answer generation. Their counts describe model context, not an invoice. See the official [token-counting guide](https://dev.meta.ai/docs/token-counting) and [pricing reference](https://dev.meta.ai/docs/pricing-rate-limits).

This release is a judge demonstration with two personas, not a complete enterprise membership or public student-account system. The connector displays real configuration and destination receipts; an unconfigured or failed destination is never presented as a successful ClarifyCue publication.

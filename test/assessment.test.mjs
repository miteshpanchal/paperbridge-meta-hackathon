import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAssessment } from "../public/assessment.js";

test("refresh resumes the same timed attempt and answers without starting another attempt", async (t) => {
  const names = ["document", "window", "sessionStorage", "fetch", "setInterval", "clearInterval"];
  const originals = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  t.after(() => { for (const name of names) globalThis[name] = originals[name]; });
  const storage = new Map();
  globalThis.sessionStorage = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) };
  globalThis.window = { addEventListener() {} };
  let tick;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  globalThis.clearInterval = () => {};
  const paper = { name: "Test", durationMins: 1, marks: 4, penalty: 1, keyLabel: "Estimated", questions: [{ text: "Question", options: [{ text: "A" }, { text: "B" }] }] };
  let starts = 0, submitted;
  globalThis.fetch = async (url, options) => {
    let result = paper;
    if (url.endsWith("/start")) { starts++; result = { attemptToken: "same-attempt", startedAt: Date.now() }; }
    if (url.endsWith("/submit")) {
      submitted = JSON.parse(options.body);
      result = { score: 4, maxScore: 4, correct: 1, incorrect: 0, unattempted: 0, review: [], keyLabel: "Estimated" };
    }
    return { ok: true, json: async () => result };
  };
  const options = { token: "shared-test", BASE: "/metahackathon", esc: String, math: String, img: () => "" };
  function root() {
    const node = { innerHTML: "", addEventListener: (_, fn) => { node.click = fn; }, querySelector: () => ({ checked: true }) };
    globalThis.document = { querySelector: () => node };
    return node;
  }
  const click = (node, exam, rest = {}) => node.click({ target: { closest: () => ({ dataset: { exam, ...rest } }) } });
  let node = root();
  await mountAssessment(options);
  await click(node, "start");
  await click(node, "answer", { option: "1" });
  node = root();
  await mountAssessment(options);
  assert.equal(starts, 1);
  assert.match(node.innerHTML, /1 answered/);
  assert.match(node.innerHTML, /exam-clock/);
  await click(node, "submit");
  assert.deepEqual(submitted, { attemptToken: "same-attempt", answers: [1] });
  node = root();
  await mountAssessment(options);
  assert.match(node.innerHTML, /Submitted attempt/);
  assert.equal(starts, 1);
});

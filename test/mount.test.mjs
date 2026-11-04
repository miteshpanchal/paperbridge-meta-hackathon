import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.mjs";

test("/hackathon mount keeps assets, API and cookies out of the core namespace", async (t) => {
  const server = createApp({
    BASE_PATH: "/hackathon",
    JUDGE_EMAIL: "judge@example.com",
    JUDGE_PASSWORD: "strong-password",
    SESSION_SECRET: "s".repeat(40),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(base + "/hackathon/")).text();
  assert.match(page, /content="\/hackathon"/);
  assert.match(page, /src="\/hackathon\/workspace.js"/);
  assert.match(page, /href="\/hackathon\/styles.css"/);
  assert.equal((await fetch(base + "/hackathon/api/health")).status, 200);
  assert.equal((await fetch(base + "/api/health")).status, 404);
  assert.equal(
    (await fetch(base + "/hackathon/vendor/katex/katex.mjs")).status,
    200,
  );
  const login = await fetch(base + "/hackathon/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "judge@example.com",
      password: "strong-password",
    }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /Path=\/hackathon\//);
});

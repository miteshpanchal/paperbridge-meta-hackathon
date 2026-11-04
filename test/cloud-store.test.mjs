import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudStore } from "../server/cloud-store.mjs";

test("Cloud Run store pins reads and rejects concurrent writes using object generations", async () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  let generation = 1;
  let record = { id, owner: "judge-a", value: 1 };
  let metadataCalls = 0;
  const transport = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith("http://metadata.")) {
      metadataCalls++;
      return Response.json({
        access_token: "fake-service-identity",
        expires_in: 3600,
      });
    }
    assert.equal(options.headers.Authorization, "Bearer fake-service-identity");
    const u = new URL(url);
    if (u.pathname.startsWith("/upload/")) {
      if (u.searchParams.get("ifGenerationMatch") !== String(generation))
        return new Response("{}", { status: 412 });
      record = JSON.parse(options.body);
      generation++;
      return Response.json({ generation: String(generation) });
    }
    if (u.searchParams.get("alt") === "media") {
      assert.equal(u.searchParams.get("generation"), String(generation));
      return Response.json(record);
    }
    return Response.json({ generation: String(generation) });
  };
  const store = new CloudStore("paperbridge-private-demo", transport);
  assert.equal((await store.get(id, "judge-a")).value, 1);
  await assert.rejects(() => store.get(id, "judge-b"), /not found/);
  await store.update(id, "judge-a", async (paper) => {
    paper.value = 2;
    return paper;
  });
  assert.equal(record.value, 2);
  assert.equal(
    metadataCalls,
    1,
    "short-lived identity is reused until refresh",
  );
  await assert.rejects(
    () => store.save({ ...record, value: 999 }, "1"),
    /changed in another request/,
  );
  assert.equal(record.value, 2, "stale writer did not overwrite data");
});

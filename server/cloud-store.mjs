import { fail } from "./domain.mjs";

/** Private GCS objects with generation preconditions. No credentials are sent to the browser. */
export class CloudStore {
  constructor(bucket, transport = fetch) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket))
      throw new Error("Invalid DATA_BUCKET.");
    this.bucket = bucket;
    this.transport = transport;
    this.access = null;
  }
  object(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw fail(404, "Paper not found.");
    return "papers/" + id + ".json";
  }
  async token() {
    if (this.access && this.access.until > Date.now() + 60000)
      return this.access.value;
    let response;
    try {
      response = await this.transport(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      throw fail(
        503,
        "Cloud storage identity is unavailable. Run with an attached Cloud Run service account.",
      );
    }
    if (!response.ok)
      throw fail(503, "Cloud storage identity could not be obtained.");
    const data = await response.json();
    if (!data.access_token)
      throw fail(503, "Cloud storage identity is invalid.");
    this.access = {
      value: data.access_token,
      until: Date.now() + Number(data.expires_in || 300) * 1000,
    };
    return this.access.value;
  }
  async request(url, options = {}) {
    let response;
    try {
      response = await this.transport(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: "Bearer " + (await this.token()),
        },
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
    } catch (e) {
      if (e.status) throw e;
      throw fail(
        503,
        "Cloud storage request failed. Retry without changing the paper.",
      );
    }
    if (response.status === 404) throw fail(404, "Paper not found.");
    if (response.status === 412)
      throw fail(
        409,
        "This paper changed in another request. Refresh and retry; no update was overwritten.",
      );
    if (!response.ok)
      throw fail(
        503,
        "Cloud storage returned an error. Check the service account and private bucket permissions.",
      );
    return response;
  }
  async read(id, owner) {
    const path = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(this.object(id))}`;
    const metadata = await (await this.request(path)).json();
    if (!metadata.generation)
      throw fail(503, "Cloud storage generation is missing.");
    const record = await (
      await this.request(
        path +
          "?alt=media&generation=" +
          encodeURIComponent(metadata.generation),
      )
    ).json();
    if (owner && record.owner !== owner) throw fail(404, "Paper not found.");
    return { record, generation: metadata.generation };
  }
  async get(id, owner) {
    return (await this.read(id, owner)).record;
  }
  async save(record, generation = "0") {
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(this.object(record.id))}&ifGenerationMatch=${encodeURIComponent(generation)}`;
    await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    return record;
  }
  async update(id, owner, mutation) {
    const { record, generation } = await this.read(id, owner);
    const result = await mutation(record);
    await this.save(record, generation);
    return result;
  }
}

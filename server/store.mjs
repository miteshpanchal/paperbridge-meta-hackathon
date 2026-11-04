import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./domain.mjs";

export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    this.pending = new Map();
  }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw fail(404, "Paper not found.");
    return join(this.directory, id + ".json");
  }
  async get(id, owner) {
    let record;
    try {
      record = JSON.parse(await readFile(this.path(id), "utf8"));
    } catch {
      throw fail(404, "Paper not found.");
    }
    if (owner && record.owner !== owner) throw fail(404, "Paper not found.");
    return record;
  }
  async save(record) {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(record.id),
      temp = target + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, target);
    return record;
  }
  async update(id, owner, mutation) {
    const previous = this.pending.get(id) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const record = await this.get(id, owner);
        const result = await mutation(record);
        await this.save(record);
        return result;
      });
    this.pending.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(id) === operation) this.pending.delete(id);
    }
  }
}

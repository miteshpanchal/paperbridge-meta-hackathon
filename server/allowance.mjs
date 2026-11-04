import { randomUUID } from "node:crypto";
import { stableId } from "./workspaces.mjs";
import { fail } from "./domain.mjs";

// Standard-mode prices checked against Meta's public reference on 2026-11-04.
// Reservations use bounded input/output, and missing usage retains the full reservation.
export const rates = {
  "muse-spark-1.3": { input: 1.25, output: 4.25 },
  "muse-wonder-1.0": { input: 4, output: 20 },
};
export class Allowance {
  constructor(store, config = {}, now = () => new Date()) {
    this.store = store;
    this.namespace = config.JUDGE_EMAIL || "judge";
    this.now = now;
    this.usd = Number(config.META_DAILY_BUDGET_USD || 1);
    this.totalUsd = Number(config.META_TOTAL_BUDGET_USD || 5);
    this.dailyRequests = Number(config.META_DAILY_REQUEST_LIMIT || 48);
    this.sessionRequests = Number(config.META_SESSION_REQUEST_LIMIT || 24);
    this.inputLimit = Number(config.META_INPUT_TOKEN_LIMIT || 32768);
    if (
      ![
        this.usd,
        this.totalUsd,
        this.dailyRequests,
        this.sessionRequests,
        this.inputLimit,
      ].every((n) => Number.isFinite(n) && n > 0)
    )
      throw new Error("Configure positive Meta allowance limits.");
  }
  id() {
    return stableId(`allowance-total:${this.namespace}`);
  }
  async update(id, mutation) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.store.update(id, null, mutation);
      } catch (e) {
        if (e.status !== 409 || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
    }
  }
  async get() {
    const id = this.id();
    try {
      return await this.store.get(id);
    } catch (e) {
      if (e.status !== 404) throw e;
      try {
        await this.store.create({
          id,
          kind: "DEPLOYMENT_ALLOWANCE",
          startedAt: this.now().toISOString(),
          reservedUsd: 0,
          chargedUsd: 0,
          days: {},
          entries: [],
        });
      } catch (conflict) {
        if (conflict.status !== 409) throw conflict;
      }
      return this.store.get(id);
    }
  }
  async status(actor) {
    const ledger = await this.get(),
      date = this.now().toISOString().slice(0, 10),
      d = ledger.days[date] || {
        chargedUsd: 0,
        reservedUsd: 0,
        requests: 0,
        actors: {},
      };
    return {
      date,
      limitUsd: this.usd,
      accountedUsd: d.chargedUsd,
      reservedUsd: d.reservedUsd,
      requests: d.requests,
      requestLimit: this.dailyRequests,
      sessionRequests: d.actors[actor] || 0,
      sessionRequestLimit: this.sessionRequests,
      remainingUsd: Math.max(0, this.usd - d.chargedUsd - d.reservedUsd),
      totalLimitUsd: this.totalUsd,
      totalAccountedUsd: ledger.chargedUsd,
      totalReservedUsd: ledger.reservedUsd,
      totalRemainingUsd: Math.max(
        0,
        this.totalUsd - ledger.chargedUsd - ledger.reservedUsd,
      ),
      note: "Conservative allowance accounting; provider billing is authoritative. Uncertain calls retain their reservation.",
    };
  }
  async reserve(
    model,
    actor,
    inputTokens = 0,
    outputTokens = 0,
    audioSeconds = 0,
  ) {
    if (inputTokens > this.inputLimit)
      throw fail(
        422,
        "This input exceeds the token allowance. Select a smaller source region.",
      );
    const pricing = rates[model];
    const ceiling = pricing
      ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1e6
      : model === "sam-3.1"
        ? 0.0025
        : model === "muse-voice-transcribe-1.0"
          ? (audioSeconds * 0.18) / 3600
          : NaN;
    if (!Number.isFinite(ceiling) || ceiling < 0)
      throw fail(422, "Unknown model allowance.");
    const ledger = await this.get(),
      entry = {
        id: randomUUID(),
        model,
        actor,
        ceiling,
        at: this.now().toISOString(),
        date: this.now().toISOString().slice(0, 10),
      };
    await this.update(ledger.id, async (l) => {
      const d = (l.days[entry.date] ||= {
        chargedUsd: 0,
        reservedUsd: 0,
        requests: 0,
        actors: {},
      });
      if (
        d.requests >= this.dailyRequests ||
        (d.actors[actor] || 0) >= this.sessionRequests ||
        d.chargedUsd + d.reservedUsd + ceiling > this.usd ||
        l.chargedUsd + l.reservedUsd + ceiling > this.totalUsd
      )
        throw fail(
          429,
          "The judge inference allowance is exhausted. Saved papers remain available; no new model request was sent.",
        );
      d.requests++;
      d.actors[actor] = (d.actors[actor] || 0) + 1;
      d.reservedUsd += ceiling;
      l.reservedUsd += ceiling;
      l.entries.push(entry);
    });
    return { dayId: ledger.id, ...entry };
  }
  async settle(reservation, usage) {
    if (!reservation) return;
    const pricing = rates[reservation.model];
    const input = usage?.prompt_tokens ?? usage?.input_tokens,
      output = usage?.completion_tokens ?? usage?.output_tokens;
    const known =
      pricing &&
      Number.isInteger(input) &&
      input >= 0 &&
      Number.isInteger(output) &&
      output >= 0;
    const actual = known
      ? (input * pricing.input + output * pricing.output) / 1e6
      : pricing
        ? null
        : reservation.ceiling;
    if (actual === null) return;
    await this.update(reservation.dayId, async (ledger) => {
      const entry = ledger.entries.find((e) => e.id === reservation.id);
      if (!entry || entry.settled) return;
      entry.settled = true;
      entry.accountedUsd = actual;
      entry.usage = usage || null;
      const d = ledger.days[entry.date];
      d.reservedUsd = Math.max(0, d.reservedUsd - entry.ceiling);
      d.chargedUsd += actual;
      ledger.reservedUsd = Math.max(0, ledger.reservedUsd - entry.ceiling);
      ledger.chargedUsd += actual;
    });
  }
}

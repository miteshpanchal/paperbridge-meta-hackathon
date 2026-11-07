export function processingClient({ api, state, render }) {
  const key = () => "pb-" + state.journey + "-pending-job";
  async function wait(id) {
    let lastProgress;
    for (;;) {
      const job = await api("/jobs/" + id);
      state.progress = `${job.action} · ${job.stage}`;
      if (state.progress !== lastProgress) {
        lastProgress = state.progress;
        render();
      }
      if (job.status === "SUCCEEDED") {
        sessionStorage.removeItem(key());
        const result = job.result?.paperId
          ? await api("/papers/" + job.result.paperId)
          : job.result;
        return { job, result };
      }
      if (["FAILED", "INTERRUPTED"].includes(job.status)) {
        sessionStorage.removeItem(key());
        if (job.paperId) {
          try { state.paper = await api("/papers/" + job.paperId); } catch {}
        }
        throw new Error(
          job.error?.message ||
            "Processing was interrupted. The input was not automatically sent again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  return {
    async run(path, input) {
      const match = path.match(
        /^\/papers\/([a-f0-9-]{36})\/(pages|recover|audit|audit-selection|responses|coach|voice)$/,
      );
      if (!match) throw new Error("Unsupported processing action.");
      const job = await api(`/papers/${match[1]}/jobs`, {
        action: match[2],
        input,
        requestId: crypto.randomUUID(),
      });
      sessionStorage.setItem(key(), job.id);
      return (await wait(job.id)).result;
    },
    async resume() {
      const id = sessionStorage.getItem(key());
      if (!id) return null;
      try { return await wait(id); }
      catch (error) {
        if (/not found|sign in/i.test(error.message)) sessionStorage.removeItem(key());
        throw error;
      }
    },
  };
}

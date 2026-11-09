const pause = (signal) => new Promise((resolve) => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, 2000);
  signal.addEventListener("abort", finish, { once: true });
});

export function createUnityPullSync({ request, read, merge, status, wait = pause, maxPolls = 60 }) {
  let pending = null;
  let requestId = null;
  let controller = null;
  return {
    get pending() { return pending !== null || requestId !== null; },
    resume(job) { if (!pending && job?.kind === "refresh" && ["queued", "claimed"].includes(job.state)) pending = job.id; },
    stop() { controller?.abort(); },
    reset() { controller?.abort(); controller = null; pending = null; requestId = null; },
    async synchronize() {
      if (controller) return;
      const current = new AbortController();
      controller = current;
      try {
        if (!pending) {
          requestId ||= crypto.randomUUID();
          const result = await request(requestId);
          if (current.signal.aborted) return;
          pending = result.job_id;
          requestId = null;
        }
        status("En attente de Unity… Gardez le projet et sa fenêtre PixelBoard ouverts.");
        for (let attempt = 0; attempt < maxPolls; attempt++) {
          const state = await read();
          if (current.signal.aborted) return;
          const job = state.jobs.find((entry) => entry.id === pending);
          if (!job) throw new Error("Demande introuvable. Consultez les détails de synchronisation avant de réessayer.");
          if (job.state === "succeeded") {
            if (!state.snapshot) throw new Error("Unity a répondu sans instantané. Relancez sa publication puis réessayez.");
            await merge(state);
            if (current.signal.aborted) return;
            pending = null;
            return;
          }
          if (!["queued", "claimed"].includes(job.state)) {
            pending = null;
            throw new Error(`Synchronisation non effectuée (${job.state}). ${job.result?.message || "Consultez les détails puis réessayez."}`);
          }
          if (job.state === "claimed") status("Unity prépare les données… Aucun changement n’est envoyé vers Unity.");
          if (attempt < maxPolls - 1) await wait(current.signal);
          if (current.signal.aborted) return;
        }
        status("Toujours en attente de Unity. Ouvrez le projet et sa fenêtre PixelBoard, puis cliquez à nouveau pour vérifier cette même demande.");
      } finally {
        if (controller === current) controller = null;
      }
    },
  };
}

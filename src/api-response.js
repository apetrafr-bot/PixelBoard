export async function apiResponse(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Le serveur ne répond pas dans le délai prévu. Réessayez sans fermer cette page."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        const error = new Error("L’API équipe PHP n’est pas installée à cette adresse.");
        error.apiMissing = true;
        throw error;
      }
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Réponse du serveur invalide.");
      }
      return { response, payload };
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

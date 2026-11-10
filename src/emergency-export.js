export async function memoryExport(records, members, workspaceId, blobDataUrl) {
  const snapshot = structuredClone(records);
  const memberSnapshot = structuredClone(members);
  for (const record of snapshot) {
    for (const item of record.items || []) {
      for (const key of ["image", "coverImage", "audio"]) {
        if (item[key] instanceof Blob) item[key] = await blobDataUrl(item[key]);
      }
    }
  }
  snapshot.push({ id: workspaceId, members: memberSnapshot });
  return JSON.stringify({ format: "pixelboard", version: 1, exportedAt: new Date().toISOString(), records: snapshot }, null, 2);
}

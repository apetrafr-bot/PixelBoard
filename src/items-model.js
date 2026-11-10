export const ITEM_TYPES = ["TilesClass", "ToolClass", "WeaponsClass", "ArmureClass"];
export const catalogueId = (projectId) => `__items__:${projectId}`;
export const isCatalogue = (record) => record?.recordType === "item-catalogue";
export const assetKey = (asset) => asset ? `${asset.guid}:${asset.file_id}` : "";
export const itemThumbnail = (item) => item?.illustration || item?.unityThumbnail || null;

export function newCatalogue(projectId, snapshot) {
  return {
    id: catalogueId(projectId), recordType: "item-catalogue", projectId,
    title: "Catalogue Unity", parentId: null, items: [], definitions: [],
    schemaHash: snapshot.schema_hash, schema: structuredClone(snapshot.schema),
  };
}

export function fieldDefault(field) {
  if (field.default !== undefined) return structuredClone(field.default);
  if (field.kind === "object") return defaults(field.fields);
  if (field.kind === "list") return [];
  if (field.kind === "asset" || field.kind === "unsupported") return null;
  if (field.kind === "string") return "";
  if (field.kind === "bool") return false;
  if (field.kind === "color") return { r: 1, g: 1, b: 1, a: 1 };
  if (field.kind.startsWith("vector")) return Object.fromEntries(["x", "y", "z", "w"].slice(0, Number(field.kind.at(-1))).map((key) => [key, 0]));
  return field.options?.[0]?.value ?? 0;
}

export function defaults(fields) {
  return Object.fromEntries(fields.map((field) => [field.name, fieldDefault(field)]));
}

export function schemaChanges(previous, next) {
  const flatten = (schema) => {
    const result = new Map();
    const visit = (fields, prefix) => fields.forEach((field) => {
      const path = `${prefix}.${field.name}`;
      result.set(path, JSON.stringify([field.kind, field.type, field.options, field.flags]));
      if (field.fields) visit(field.fields, path);
      if (field.element) visit([field.element], `${path}[]`);
    });
    schema.families.forEach((family) => visit(family.fields, family.type));
    return result;
  };
  const before = flatten(previous);
  const after = flatten(next);
  const changes = [];
  for (const [path, type] of after) changes.push(!before.has(path) ? `Ajout : ${path}` : before.get(path) !== type ? `Type modifié : ${path}` : null);
  for (const path of before.keys()) if (!after.has(path)) changes.push(`Retrait : ${path} (ancienne valeur conservée)`);
  return changes.filter(Boolean);
}

export function migrateValues(fields, values) {
  const copy = structuredClone(values);
  for (const field of fields) {
    if (!Object.hasOwn(copy, field.name)) copy[field.name] = fieldDefault(field);
    else if (field.kind === "object" && copy[field.name] && typeof copy[field.name] === "object" && !Array.isArray(copy[field.name])) {
      copy[field.name] = migrateValues(field.fields, copy[field.name]);
    } else if (field.kind === "list" && Array.isArray(copy[field.name]) && field.element.kind === "object") {
      copy[field.name] = copy[field.name].map((value) => value && typeof value === "object" && !Array.isArray(value) ? migrateValues(field.element.fields, value) : value);
    }
  }
  return copy;
}

export function snapshotMerge(catalogue, snapshot, makeId, overwriteIds = new Set()) {
  const next = structuredClone(catalogue);
  const conflicts = [];
  for (const unity of snapshot.items) {
    const current = next.definitions.find((item) => assetKey(item.unity) === assetKey(unity));
    const identity = { guid: unity.guid, file_id: unity.file_id, fingerprint: unity.fingerprint };
    if (!current) {
      next.definitions.push({
        id: makeId(), type: unity.type, name: unity.name, values: structuredClone(unity.values),
        schemaHash: snapshot.schema_hash, unity: identity, revision: 1, archived: false,
        lastUnityValues: structuredClone(unity.values),
        unityThumbnail: unity.thumbnail ?? null,
      });
    } else {
      const thumbnailChanged = Object.hasOwn(unity, "thumbnail") && current.unityThumbnail !== unity.thumbnail;
      if (thumbnailChanged) {
        current.unityThumbnail = unity.thumbnail;
        current.revision++;
      }
      if (JSON.stringify(current.values) !== JSON.stringify(unity.values) || current.unity.fingerprint !== unity.fingerprint) {
        if (!overwriteIds.has(current.id)) conflicts.push({ id: current.id, current, unity });
        else {
          Object.assign(current, { values: structuredClone(unity.values), name: unity.name, schemaHash: snapshot.schema_hash, unity: identity, lastUnityValues: structuredClone(unity.values), revision: current.revision + 1 });
        }
      }
    }
  }
  return { catalogue: next, conflicts };
}

export function itemSyncState(item, snapshot) {
  if (item.archived) return "archived";
  if (!snapshot) return "offline";
  if (item.schemaHash !== snapshot.schema_hash) return "schema";
  if (!item.unity) return "new";
  const actual = snapshot.items.find((entry) => assetKey(entry) === assetKey(item.unity));
  if (!actual) return "missing";
  if (actual.fingerprint !== item.unity.fingerprint) return "conflict";
  return JSON.stringify(actual.values) === JSON.stringify(item.values) ? "synced" : "modified";
}

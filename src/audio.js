export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const AUDIO_ACCEPT = ".mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg";
const aliases = { "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "application/ogg": "audio/ogg" };
const extensions = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };

export function audioMime(file) {
  const declared = file.type?.toLowerCase();
  return aliases[declared] || (declared && declared !== "application/octet-stream" ? declared : extensions[file.name?.split(".").at(-1).toLowerCase()]);
}

export function audioHeaderValid(bytes, mime) {
  const text = (offset, value) => [...value].every((letter, index) => bytes[offset + index] === letter.charCodeAt(0));
  if (mime === "audio/wav") return bytes.length >= 12 && text(0, "RIFF") && text(8, "WAVE");
  if (mime === "audio/ogg") return bytes.length >= 4 && text(0, "OggS");
  if (mime === "audio/mpeg") return bytes.length >= 3 && (text(0, "ID3") || (bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] & 6) !== 0 && (bytes[1] & 24) !== 8));
  return false;
}

export async function prepareAudio(file) {
  if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error("Chaque son doit contenir des données et ne pas dépasser 15 Mio.");
  const mime = audioMime(file);
  if (!audioHeaderValid(new Uint8Array(await file.slice(0, 12).arrayBuffer()), mime)) {
    throw new Error("Son invalide ou non pris en charge. Choisissez un fichier MP3, WAV ou OGG.");
  }
  return new Blob([file], { type: mime });
}

export async function restoreAudio(value) {
  if (value instanceof Blob) return prepareAudio(value);
  if (typeof value !== "string" || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 30
      || !/^data:audio\/(?:mpeg|wav|ogg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Le son sauvegardé est invalide ou dépasse 15 Mio.");
  }
  return prepareAudio(await (await fetch(value)).blob());
}

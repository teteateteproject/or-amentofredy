// Armazenamento de propostas, fotos e biblioteca.
// - Local (npm start): arquivos JSON em data/.
// - Vercel (store conectado: BLOB_READ_WRITE_TOKEN ou BLOB_STORE_ID via OIDC): Vercel Blob, tudo privado.
import crypto from "node:crypto";
import * as fsBackend from "./storage/fs.js";
import * as blobBackend from "./storage/blob.js";

const HAS_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const backend = HAS_BLOB ? blobBackend : fsBackend;
export const BACKEND_NAME = HAS_BLOB ? "vercel-blob" : fsBackend.IS_EPHEMERAL ? "temporário" : "arquivos locais (data/)";
/** true quando os dados somem a cada deploy (Vercel sem Blob store). */
export const STORAGE_EPHEMERAL = !HAS_BLOB && fsBackend.IS_EPHEMERAL;
export const UPLOADS_DIR = fsBackend.UPLOADS_DIR;

export function newId(bytes = 9) {
  return crypto.randomBytes(bytes).toString("base64url");
}

const SAFE_ID = /^[A-Za-z0-9_-]{6,40}$/;
export function isValidId(id) {
  return typeof id === "string" && SAFE_ID.test(id);
}

/* ---------- Imagens: validação pelos bytes iniciais ---------- */
const MAGIC = [
  { ext: "png", mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", mime: "image/webp", test: (b) => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP" },
];
export function sniffImage(buf) {
  return MAGIC.find((m) => m.test(buf)) || null;
}

/* ---------- Propostas ---------- */
export async function saveProposal(proposal) {
  listCache = null;
  if (!isValidId(proposal.id)) throw new Error("id inválido");
  await backend.writeJson(`proposals/${proposal.id}.json`, proposal);
  return proposal;
}
export async function getProposal(id) {
  if (!isValidId(id)) return null;
  return backend.readJson(`proposals/${id}.json`);
}
let listCache = null; // { at, all }
const LIST_TTL = 2 * 60 * 1000;
export async function listProposals({ limit = 50 } = {}) {
  if (!listCache || Date.now() - listCache.at > LIST_TTL) listCache = { at: Date.now(), all: await backend.listJson("proposals/") };
  const all = listCache.all;
  const items = all.map((p) => ({
    id: p.id,
    clientName: p.clientName,
    destination: p.options?.[0]?.destination?.city || "",
    options: p.options?.length || 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    views: p.stats?.views || 0,
    chosenOption: p.stats?.chosenOption ?? null,
    createdBy: p.attendant?.name || p.attendant?.email || "",
  }));
  items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return items.slice(0, limit);
}

/* ---------- Uploads (fotos) ---------- */
export async function saveUpload(buf) {
  const kind = sniffImage(buf);
  if (!kind) throw Object.assign(new Error("Formato não aceito. Use PNG, JPEG ou WEBP."), { status: 415 });
  const id = `${newId(12)}.${kind.ext}`;
  const url = await backend.writeImage(id, buf, kind.mime);
  return { id, url, mime: kind.mime };
}

const UPLOAD_ID = /^[A-Za-z0-9_-]{6,40}\.(png|jpg|webp)$/;
export async function getUpload(id) {
  if (!UPLOAD_ID.test(id || "")) return null;
  return backend.readImage(id);
}

/* ---------- Biblioteca de fotos por hotel ---------- */
export function hotelKey(name, city = "") {
  return `${name} ${city}`
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
async function readLibrary() {
  return (await backend.readJson("library.json")) || { hotels: [] };
}
async function writeLibrary(lib) {
  await backend.writeJson("library.json", lib);
}
function summarize(h) {
  return { key: h.key, name: h.name, city: h.city, photos: h.photos.filter((p) => !p.reported).map((p) => p.url) };
}
export async function searchLibrary(query) {
  const lib = await readLibrary();
  const q = hotelKey(query || "");
  if (!q) return lib.hotels.slice(0, 8).map(summarize);
  const terms = q.split(" ").filter(Boolean);
  return lib.hotels.filter((h) => terms.every((t) => h.key.includes(t))).slice(0, 8).map(summarize);
}
export async function getLibraryHotel(key) {
  const lib = await readLibrary();
  const h = lib.hotels.find((x) => x.key === key);
  return h ? summarize(h) : null;
}
const isPhotoUrl = (u) => typeof u === "string" && (u.startsWith("/uploads/") || /^https:\/\//.test(u));
/** Junta as fotos de um hotel na biblioteca em memória. Devolve true se mudou algo. */
function mergeHotel(lib, { name, city, photos }) {
  if (!name || !photos?.length) return false;
  const key = hotelKey(name, city);
  let h = lib.hotels.find((x) => x.key === key);
  let changed = false;
  if (!h) {
    h = { key, name, city: city || "", photos: [] };
    lib.hotels.push(h);
    changed = true;
  }
  for (const url of photos) {
    if (!isPhotoUrl(url) || h.photos.some((p) => p.url === url)) continue;
    h.photos.push({ url, reported: false, addedAt: new Date().toISOString() });
    changed = true;
  }
  return changed;
}
/** Adiciona as fotos de vários hotéis com uma leitura e no máximo uma gravação (o Blob cobra cada gravação). */
export async function addHotelsToLibrary(hotels = []) {
  const withPhotos = hotels.filter((h) => h?.name && h.photos?.length);
  if (!withPhotos.length) return;
  const lib = await readLibrary();
  let changed = false;
  for (const h of withPhotos) changed = mergeHotel(lib, h) || changed;
  if (changed) await writeLibrary(lib);
}
export const addToLibrary = (hotel) => addHotelsToLibrary([hotel]);
export async function reportLibraryPhoto(key, url) {
  const lib = await readLibrary();
  const h = lib.hotels.find((x) => x.key === key);
  const p = h?.photos.find((x) => x.url === url);
  if (!p) return false;
  p.reported = true;
  p.reportedAt = new Date().toISOString();
  await writeLibrary(lib);
  return true;
}

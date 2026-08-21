var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/utils/tar.js
var BLOCK = 512;
var DEFAULT_CHUNK_BYTES = 1024 * 1024;
function readString(bytes, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) end += 1;
  return new TextDecoder("utf-8").decode(bytes.subarray(offset, end));
}
__name(readString, "readString");
function parseNumeric(bytes, offset, length) {
  if (bytes[offset] & 128) {
    let value = bytes[offset] & 127;
    for (let i = 1; i < length; i += 1) {
      value = value * 256 + bytes[offset + i];
    }
    return value;
  }
  const raw = readString(bytes, offset, length).trim();
  if (raw === "") return 0;
  return Number.parseInt(raw, 8);
}
__name(parseNumeric, "parseNumeric");
function isAllZero(bytes) {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}
__name(isAllZero, "isAllZero");
var TarReader = class {
  static {
    __name(this, "TarReader");
  }
  /**
   * @param {ReadableStream} stream استریم خام (در صورت نیاز gzip از بیرون باز شده باشد)
   */
  constructor(stream) {
    this._reader = stream.getReader();
    this._buf = new Uint8Array(0);
    this._done = false;
    this._remaining = 0;
    this._afterPad = 0;
    this._pendingLongName = null;
  }
  async _fill(minBytes) {
    while (this._buf.length < minBytes && !this._done) {
      const result = await this._reader.read();
      if (result.done) {
        this._done = true;
        break;
      }
      const chunk = result.value;
      const merged = new Uint8Array(this._buf.length + chunk.length);
      merged.set(this._buf, 0);
      merged.set(chunk, this._buf.length);
      this._buf = merged;
    }
    return this._buf.length >= minBytes;
  }
  /** ورودی بعدی — یا null در پایان archive */
  async next() {
    await this._skipEntryData();
    if (!await this._fill(BLOCK)) {
      return null;
    }
    const header = this._buf.subarray(0, BLOCK);
    if (isAllZero(header)) {
      this._buf = this._buf.subarray(BLOCK);
      return null;
    }
    const rawName = readString(header, 0, 100);
    const size = parseNumeric(header, 124, 12);
    const typeCode = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);
    const magic = readString(header, 257, 6);
    let name = magic.startsWith("ustar") && prefix ? `${prefix}/${rawName}` : rawName;
    this._buf = this._buf.subarray(BLOCK);
    if (typeCode === "L") {
      this._pendingLongName = new TextDecoder("utf-8").decode(await this._readAllEntry()).replace(/\0+$/, "");
      return this.next();
    }
    if (this._pendingLongName) {
      name = this._pendingLongName;
      this._pendingLongName = null;
    }
    this._remaining = size;
    this._afterPad = size % BLOCK === 0 ? 0 : BLOCK - size % BLOCK;
    return { name, size, typeflag: typeCode };
  }
  /** حداکثر maxBytes از داده‌ی entry جاری */
  async readChunk(maxBytes = DEFAULT_CHUNK_BYTES) {
    if (this._remaining === 0) return null;
    const want = Math.min(maxBytes, this._remaining);
    if (!await this._fill(Math.min(want, BLOCK * 2)) && this._buf.length === 0) {
      this._remaining = 0;
      this._afterPad = 0;
      return null;
    }
    const take = Math.min(want, this._buf.length);
    if (take === 0) {
      this._remaining = 0;
      this._afterPad = 0;
      return null;
    }
    const chunk = this._buf.subarray(0, take);
    this._buf = this._buf.subarray(take);
    this._remaining -= take;
    return chunk;
  }
  async _skipEntryData() {
    while (this._remaining > 0) {
      if (this._buf.length === 0 && !await this._fill(BLOCK)) {
        this._remaining = 0;
        this._afterPad = 0;
        return;
      }
      const take = Math.min(this._remaining, this._buf.length);
      this._buf = this._buf.subarray(take);
      this._remaining -= take;
    }
    while (this._afterPad > 0) {
      if (this._buf.length === 0 && !await this._fill(Math.min(this._afterPad, BLOCK))) {
        this._afterPad = 0;
        return;
      }
      const take = Math.min(this._afterPad, this._buf.length);
      this._buf = this._buf.subarray(take);
      this._afterPad -= take;
    }
  }
  /** کل داده‌ی entry جاری (فقط برای اعضای کوچک مثل JSON) */
  async _readAllEntry() {
    const parts = [];
    let total = 0;
    for (; ; ) {
      const chunk = await this.readChunk(DEFAULT_CHUNK_BYTES);
      if (!chunk) break;
      parts.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  readAll() {
    return this._readAllEntry();
  }
  /**
   * داده‌ی entry جاری به‌صورت ReadableStream (برای استریم کردن blobهای بزرگ).
   * توجه: تا پایان مصرف این استریم، next() صدا زده نشود.
   */
  entryStream(chunkBytes = DEFAULT_CHUNK_BYTES) {
    return new ReadableStream({
      pull: /* @__PURE__ */ __name(async (controller) => {
        const chunk = await this.readChunk(chunkBytes);
        if (!chunk || chunk.length === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      }, "pull")
    });
  }
};

// src/utils/sha256.js
var HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
async function sha256Digest(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < view.length; i += 1) {
    hex += HEX[view[i]];
  }
  return `sha256:${hex}`;
}
__name(sha256Digest, "sha256Digest");

// src/services/converter.js
var SMALL_BLOB_LIMIT = 8 * 1024 * 1024;
var LEGACY_MAX_BYTES = 96 * 1024 * 1024;
var OCI_MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
var INDEX_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json"
];
function isContentAddressedBlob(name) {
  return /^blobs\/sha256\/[0-9a-f]{64}$/.test(name);
}
__name(isContentAddressedBlob, "isContentAddressedBlob");
function blobNameToDigest(name) {
  return `sha256:${name.slice("blobs/sha256/".length)}`;
}
__name(blobNameToDigest, "blobNameToDigest");
function digestToBlobName(digest) {
  return `blobs/sha256/${digest.replace("sha256:", "")}`;
}
__name(digestToBlobName, "digestToBlobName");
function text(bytes) {
  return new TextDecoder().decode(bytes);
}
__name(text, "text");
async function gzipBuffer(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
__name(gzipBuffer, "gzipBuffer");
async function convertTarStream(tarStream, store, options = {}) {
  const os = options.os || "linux";
  const arch = options.arch || "amd64";
  const reader = new TarReader(tarStream);
  const smallFiles = /* @__PURE__ */ new Map();
  const streamedBlobs = /* @__PURE__ */ new Set();
  let legacyBuffered = 0;
  for (; ; ) {
    const entry = await reader.next();
    if (!entry) break;
    const { name, size } = entry;
    if (entry.typeflag === "5" || entry.typeflag === "x" || entry.typeflag === "g") {
      await reader.readAll();
      continue;
    }
    if (isContentAddressedBlob(name) && size > SMALL_BLOB_LIMIT) {
      const digest = blobNameToDigest(name);
      await store.putBlob(digest, reader.entryStream());
      streamedBlobs.add(digest);
      continue;
    }
    if (size > LEGACY_MAX_BYTES || legacyBuffered + size > LEGACY_MAX_BYTES) {
      throw new Error(
        "\u0644\u0627\u06CC\u0647\u200C\u0647\u0627\u06CC \u0628\u0632\u0631\u06AF\u0650 \u0641\u0631\u0645\u062A \u06A9\u0644\u0627\u0633\u06CC\u06A9 docker save \u0631\u0648\u06CC Worker \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0646\u0645\u06CC\u200C\u0634\u0648\u0646\u062F (\u062D\u062C\u0645 \u0628\u0627\u0641\u0631 \u0628\u06CC\u0634 \u0627\u0632 \u062D\u062F \u0645\u062C\u0627\u0632 \u0627\u0633\u062A)\u061B \u0627\u0632 \u0641\u0631\u0645\u062A OCI layout \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u06CC\u062F"
      );
    }
    const bytes = await reader.readAll();
    smallFiles.set(name, bytes);
    legacyBuffered += bytes.length;
  }
  if (smallFiles.has("oci-layout") && smallFiles.has("index.json")) {
    return convertOciLayout(smallFiles, streamedBlobs, store, { os, arch });
  }
  if (smallFiles.has("manifest.json")) {
    return convertDockerSave(smallFiles, store);
  }
  throw new Error("\u0641\u0631\u0645\u062A \u062A\u0635\u0648\u06CC\u0631 \u0646\u0627\u0634\u0646\u0627\u062E\u062A\u0647 \u0627\u0633\u062A (\u0646\u0647 OCI layout \u0648 \u0646\u0647 docker save \u06A9\u0644\u0627\u0633\u06CC\u06A9)");
}
__name(convertTarStream, "convertTarStream");
async function getBufferedOrStreamed(smallFiles, streamedBlobs, store, digest) {
  const name = digestToBlobName(digest);
  if (smallFiles.has(name)) {
    return smallFiles.get(name);
  }
  if (streamedBlobs.has(digest)) {
    const blob = await store.getBlob(digest);
    if (!blob) throw new Error(`blob ${digest} \u0628\u0639\u062F \u0627\u0632 \u0646\u0648\u0634\u062A\u0646 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F`);
    return new Uint8Array(await new Response(blob.stream).arrayBuffer());
  }
  return null;
}
__name(getBufferedOrStreamed, "getBufferedOrStreamed");
async function convertOciLayout(smallFiles, streamedBlobs, store, { os, arch }) {
  let index;
  try {
    index = JSON.parse(text(smallFiles.get("index.json")));
  } catch (err) {
    throw new Error(`index.json \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A: ${err.message}`);
  }
  let manifestDesc = index.manifests && index.manifests[0];
  if (!manifestDesc) {
    throw new Error("index.json \u0647\u06CC\u0686 \u0645\u0646\u06CC\u0641\u0633\u062A\u06CC \u0646\u062F\u0627\u0634\u062A");
  }
  const isIndexType = INDEX_MEDIA_TYPES.includes(manifestDesc.mediaType);
  if (isIndexType) {
    const subIndexBytes = await getBufferedOrStreamed(
      smallFiles,
      streamedBlobs,
      store,
      manifestDesc.digest
    );
    if (!subIndexBytes) {
      throw new Error(`manifest list ${manifestDesc.digest} \u062F\u0631 tarball \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F`);
    }
    const subIndex = JSON.parse(text(subIndexBytes));
    const match = (subIndex.manifests || []).find(
      (m) => m.platform && m.platform.os === os && m.platform.architecture === arch
    );
    manifestDesc = match || subIndex.manifests[0];
    if (!manifestDesc) {
      throw new Error("manifest list \u0648\u0631\u0648\u062F\u06CC \u0646\u062F\u0627\u0634\u062A");
    }
  }
  const manifestBytes = await getBufferedOrStreamed(
    smallFiles,
    streamedBlobs,
    store,
    manifestDesc.digest
  );
  if (!manifestBytes) {
    throw new Error(`\u0645\u0646\u06CC\u0641\u0633\u062A ${manifestDesc.digest} \u062F\u0631 tarball \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text(manifestBytes));
  } catch (err) {
    throw new Error(`\u0645\u0646\u06CC\u0641\u0633\u062A \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A: ${err.message}`);
  }
  const keep = /* @__PURE__ */ new Set();
  if (manifest.config && manifest.config.digest) keep.add(manifest.config.digest);
  for (const layer of manifest.layers || []) {
    if (layer.digest) keep.add(layer.digest);
  }
  for (const digest of keep) {
    const name = digestToBlobName(digest);
    if (smallFiles.has(name)) {
      await store.putBlob(digest, smallFiles.get(name));
    } else if (!streamedBlobs.has(digest)) {
      throw new Error(`blob ${digest} \u062F\u0631 tarball \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F`);
    }
  }
  for (const digest of streamedBlobs) {
    if (!keep.has(digest)) {
      await store.deleteBlob(digest);
    }
  }
  const manifestDigest = await sha256Digest(manifestBytes);
  const mediaType = manifest.mediaType || OCI_MANIFEST_TYPE;
  await store.putManifest(manifestDigest, manifestBytes, mediaType);
  return { digest: manifestDigest, mediaType };
}
__name(convertOciLayout, "convertOciLayout");
async function convertDockerSave(smallFiles, store) {
  let manifestList;
  try {
    manifestList = JSON.parse(text(smallFiles.get("manifest.json")));
  } catch (err) {
    throw new Error(`manifest.json \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A: ${err.message}`);
  }
  const entry = manifestList[0];
  if (!entry) {
    throw new Error("manifest.json \u0648\u0631\u0648\u062F\u06CC \u0646\u062F\u0627\u0634\u062A");
  }
  const configBuf = smallFiles.get(entry.Config);
  if (!configBuf) {
    throw new Error(`\u0641\u0627\u06CC\u0644 \u06A9\u0627\u0646\u0641\u06CC\u06AF ${entry.Config} \u062F\u0631 tarball \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F`);
  }
  const configDigest = await sha256Digest(configBuf);
  await store.putBlob(configDigest, configBuf);
  const layers = [];
  for (const layerPath of entry.Layers || []) {
    const rawBuf = smallFiles.get(layerPath);
    if (!rawBuf) {
      throw new Error(`\u0644\u0627\u06CC\u0647 ${layerPath} \u062F\u0631 tarball \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F`);
    }
    const gzBuf = await gzipBuffer(rawBuf);
    const digest = await sha256Digest(gzBuf);
    await store.putBlob(digest, gzBuf);
    layers.push({
      mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
      size: gzBuf.length,
      digest
    });
  }
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: {
      mediaType: "application/vnd.docker.container.image.v1+json",
      size: configBuf.length,
      digest: configDigest
    },
    layers
  };
  const manifestBuf = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = await sha256Digest(manifestBuf);
  await store.putManifest(manifestDigest, manifestBuf, manifest.mediaType);
  return { digest: manifestDigest, mediaType: manifest.mediaType };
}
__name(convertDockerSave, "convertDockerSave");

// src/services/registry.js
function createRegistryService({
  store,
  getRegistries: getRegistries2,
  fetchTarball: fetchTarball2,
  os = "linux",
  arch = "amd64"
}) {
  const pending = /* @__PURE__ */ new Map();
  function cacheKey(name, reference) {
    return `${name}:${reference}`;
  }
  __name(cacheKey, "cacheKey");
  async function attemptRegistry(registry, name, reference) {
    const imageRef = `${registry}/${name}:${reference}`;
    let stream;
    try {
      stream = await fetchTarball2(imageRef);
    } catch (err) {
      throw new Error(`${registry}: ${err.message}`);
    }
    try {
      const result = await convertTarStream(stream, store, { os, arch });
      return { registry, digest: result.digest };
    } catch (err) {
      throw new Error(`${registry}: ${err.message}`);
    }
  }
  __name(attemptRegistry, "attemptRegistry");
  async function resolveManifest(name, reference) {
    if (reference.startsWith("sha256:") && await store.hasManifest(reference)) {
      return store.getManifest(reference);
    }
    const digest = await store.getTagDigest(name, reference);
    if (digest && await store.hasManifest(digest)) {
      return store.getManifest(digest);
    }
    const key = cacheKey(name, reference);
    if (!pending.has(key)) {
      const job = (async () => {
        const registries = getRegistries2();
        const attempts = registries.map(
          (registry) => attemptRegistry(registry, name, reference)
        );
        let winner;
        try {
          winner = await Promise.any(attempts);
        } catch (aggregateErr) {
          const details = (aggregateErr.errors || [aggregateErr]).map((e) => e.message).join("\n");
          throw new Error(
            `\u0627\u06CC\u0645\u06CC\u062C "${name}:${reference}" \u062F\u0631 \u0647\u06CC\u0686\u200C\u06A9\u062F\u0627\u0645 \u0627\u0632 \u0631\u062C\u06CC\u0633\u062A\u0631\u06CC\u200C\u0647\u0627\u06CC \u067E\u06CC\u06A9\u0631\u0628\u0646\u062F\u06CC (REGISTRIES_JSON) \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F:
${details}`
          );
        }
        await store.setTag(name, reference, winner.digest);
        await store.setOrigin(name, winner.registry);
        return { digest: winner.digest };
      })();
      pending.set(key, job.finally(() => pending.delete(key)));
    }
    const result = await pending.get(key);
    return store.getManifest(result.digest);
  }
  __name(resolveManifest, "resolveManifest");
  return { resolveManifest };
}
__name(createRegistryService, "createRegistryService");

// src/routes/v2.js
var V2_API_HEADER = { "Docker-Distribution-Api-Version": "registry/2.0" };
function jsonError(status, code, message) {
  return Response.json(
    { errors: [{ code, message }] },
    { status, headers: V2_API_HEADER }
  );
}
__name(jsonError, "jsonError");
function createV2Router(deps) {
  const { store, cacheEnabled } = deps;
  const registry = createRegistryService({
    store,
    getRegistries: deps.getRegistries,
    fetchTarball: deps.fetchTarball,
    os: deps.os,
    arch: deps.arch
  });
  async function handleManifest(req, pathname, method) {
    const match = pathname.match(/^(.+)\/manifests\/([^/]+)$/);
    if (!match) return null;
    const name = decodeURIComponent(match[1].replace(/^\//, ""));
    const reference = decodeURIComponent(match[2]);
    try {
      const { bytes, mediaType } = await registry.resolveManifest(name, reference);
      const digest = await sha256Digest(bytes);
      const headers = {
        "Content-Type": mediaType,
        "Docker-Content-Digest": digest,
        ...V2_API_HEADER
      };
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { ...headers, "Content-Length": String(bytes.length) }
        });
      }
      return new Response(bytes, { status: 200, headers });
    } catch (err) {
      return jsonError(404, "MANIFEST_UNKNOWN", err.message);
    }
  }
  __name(handleManifest, "handleManifest");
  async function handleBlob(req, pathname, method) {
    const match = pathname.match(/^(.+)\/blobs\/(sha256:[a-f0-9]{64})$/);
    if (!match) return null;
    const digest = match[2];
    const blob = await store.getBlob(digest);
    if (!blob) {
      return jsonError(404, "BLOB_UNKNOWN", digest);
    }
    const headers = {
      "Content-Type": "application/octet-stream",
      "Docker-Content-Digest": digest,
      ...V2_API_HEADER
    };
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { ...headers, "Content-Length": String(blob.size) }
      });
    }
    return new Response(blob.stream, { status: 200, headers });
  }
  __name(handleBlob, "handleBlob");
  return /* @__PURE__ */ __name(async function v2Router(request) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname.replace(/^\/v2/, "")) || "/";
    const method = request.method.toUpperCase();
    if (pathname === "/" && (method === "GET" || method === "HEAD")) {
      return Response.json({}, { headers: V2_API_HEADER });
    }
    if (pathname === "/healthz" && method === "GET") {
      return new Response("ok", { headers: V2_API_HEADER });
    }
    if (/^\/.+\/blobs\/uploads\/?$/.test(pathname) && method === "POST") {
      return jsonError(
        501,
        "UNSUPPORTED",
        "\u0627\u06CC\u0646 \u0631\u062C\u06CC\u0633\u062A\u0631\u06CC \u0641\u0642\u0637 \u0627\u0632 pull \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0645\u06CC\u200C\u06A9\u0646\u062F"
      );
    }
    if (pathname.endsWith("/tags/list") && method === "GET") {
      const name = pathname.slice(0, -"/tags/list".length).replace(/^\//, "");
      const tags = cacheEnabled ? await store.listTags(name) : [];
      return Response.json({ name, tags }, { headers: V2_API_HEADER });
    }
    if (method === "GET" || method === "HEAD") {
      const manifestRes = await handleManifest(request, pathname, method);
      if (manifestRes) return manifestRes;
      const blobRes = await handleBlob(request, pathname, method);
      if (blobRes) return blobRes;
    }
    return null;
  }, "v2Router");
}
__name(createV2Router, "createV2Router");

// src/storage/transient.js
var BASE = "https://transient-registry.internal";
function blobUrl(digest) {
  return `${BASE}/blobs/${digest}`;
}
__name(blobUrl, "blobUrl");
function manifestUrl(digest) {
  return `${BASE}/manifests/${digest}`;
}
__name(manifestUrl, "manifestUrl");
function tagUrl(repo) {
  return `${BASE}/tags/${repo}`;
}
__name(tagUrl, "tagUrl");
function originUrl(repo) {
  return `${BASE}/origins/${repo}`;
}
__name(originUrl, "originUrl");
var TransientStore = class {
  static {
    __name(this, "TransientStore");
  }
  /**
   * @param {number} ttlSeconds عمر داده‌ها (پیش‌فرض ۱۸۰۰ ثانیه = ۳۰ دقیقه)
   */
  constructor(ttlSeconds = 1800) {
    this.cache = caches.default;
    this.ttl = `public, max-age=${Math.max(60, ttlSeconds | 0)}`;
  }
  async _get(url) {
    try {
      return await this.cache.match(new Request(url, { method: "GET" }));
    } catch (_) {
      return void 0;
    }
  }
  async _put(url, body, headers = {}) {
    try {
      await this.cache.put(
        new Request(url, { method: "GET" }),
        new Response(body, {
          headers: {
            "Cache-Control": this.ttl,
            ...headers
          }
        })
      );
    } catch (_) {
    }
  }
  async hasBlob(digest) {
    const hit = await this._get(blobUrl(digest));
    return Boolean(hit);
  }
  async putBlob(digest, data) {
    await this._put(blobUrl(digest), data);
  }
  async getBlob(digest) {
    const hit = await this._get(blobUrl(digest));
    if (!hit) return null;
    return {
      size: Number(hit.headers.get("x-blob-size") || 0),
      stream: hit.body
    };
  }
  // در استور موقت، حذف لازم نیست — TTL خودش تمیز می‌کند
  async deleteBlob() {
    return null;
  }
  async hasManifest(digest) {
    const hit = await this._get(manifestUrl(digest));
    return Boolean(hit);
  }
  async putManifest(digest, bytes, mediaType) {
    await this._put(manifestUrl(digest), bytes, {
      "Content-Type": "application/json",
      "x-media-type": mediaType
    });
  }
  async getManifest(digest) {
    const hit = await this._get(manifestUrl(digest));
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    return {
      bytes,
      mediaType: hit.headers.get("x-media-type") || "application/vnd.oci.image.manifest.v1+json"
    };
  }
  async setTag(repo, tag, digest) {
    await this._put(`${tagUrl(repo)}?tag=${encodeURIComponent(tag)}`, JSON.stringify({ digest }));
  }
  async getTagDigest(repo, tag) {
    const hit = await this._get(`${tagUrl(repo)}?tag=${encodeURIComponent(tag)}`);
    if (!hit) return void 0;
    try {
      const parsed = await hit.json();
      return parsed.digest;
    } catch (_) {
      return void 0;
    }
  }
  // مانند نسخه Node: در حالت بدون کش دائمی، فهرست تگ‌ها خالی است
  async listTags() {
    return [];
  }
  async setOrigin(repo, registry) {
    await this._put(originUrl(repo), JSON.stringify({ registry }));
  }
  async getOrigin(repo) {
    const hit = await this._get(originUrl(repo));
    if (!hit) return void 0;
    try {
      return (await hit.json()).registry;
    } catch (_) {
      return void 0;
    }
  }
  // بدون Cron/interval — انقضا با TTL انجام می‌شود
  async cleanup() {
    return null;
  }
};

// src/storage/r2.js
function hexOf(digest) {
  return digest.replace("sha256:", "");
}
__name(hexOf, "hexOf");
var R2Store = class {
  static {
    __name(this, "R2Store");
  }
  /**
   * @param {R2Bucket} bucket بایندینگ env.REGISTRY_BUCKET
   */
  constructor(bucket) {
    this.bucket = bucket;
  }
  // ---------- Blobs ----------
  blobKey(digest) {
    return `blobs/sha256/${hexOf(digest)}`;
  }
  async hasBlob(digest) {
    try {
      const head = await this.bucket.head(this.blobKey(digest));
      return Boolean(head);
    } catch (_) {
      return false;
    }
  }
  async putBlob(digest, data) {
    await this.bucket.put(this.blobKey(digest), data);
  }
  async getBlob(digest) {
    const obj = await this.bucket.get(this.blobKey(digest));
    if (!obj) return null;
    return {
      size: obj.size,
      stream: obj.body
    };
  }
  async deleteBlob(digest) {
    await this.bucket.delete(this.blobKey(digest));
  }
  // ---------- Manifests ----------
  manifestKey(digest) {
    return `manifests/${hexOf(digest)}`;
  }
  async hasManifest(digest) {
    try {
      const head = await this.bucket.head(this.manifestKey(digest));
      return Boolean(head);
    } catch (_) {
      return false;
    }
  }
  async putManifest(digest, bytes, mediaType) {
    await this.bucket.put(this.manifestKey(digest), bytes, {
      customMetadata: { mediaType }
    });
  }
  async getManifest(digest) {
    const obj = await this.bucket.get(this.manifestKey(digest));
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return {
      bytes,
      mediaType: obj.customMetadata && obj.customMetadata.mediaType || "application/vnd.oci.image.manifest.v1+json"
    };
  }
  // ---------- Tags ----------
  tagKey(repo) {
    return `tags/${repo}`;
  }
  async _readTags(repo) {
    const obj = await this.bucket.get(this.tagKey(repo));
    if (!obj) return {};
    try {
      return await obj.json();
    } catch (_) {
      return {};
    }
  }
  async setTag(repo, tag, digest) {
    const map = await this._readTags(repo);
    map[tag] = digest;
    await this.bucket.put(this.tagKey(repo), JSON.stringify(map));
  }
  async getTagDigest(repo, tag) {
    const map = await this._readTags(repo);
    return map[tag];
  }
  async listTags(repo) {
    const map = await this._readTags(repo);
    return Object.keys(map);
  }
  // ---------- Origins ----------
  async setOrigin(repo, registry) {
    await this.bucket.put(this.originKey(repo), JSON.stringify({ registry }));
  }
  originKey(repo) {
    return `origins/${repo}`;
  }
  async getOrigin(repo) {
    const obj = await this.bucket.get(this.originKey(repo));
    if (!obj) return void 0;
    try {
      return (await obj.json()).registry;
    } catch (_) {
      return void 0;
    }
  }
  // ---------- Cleanup (Cron Trigger) ----------
  /**
   * blobها را تا زیر maxBytes نگه می‌دارد — قدیمی‌ترین آپلودها اول حذف می‌شوند.
   * @returns {Promise<{removed:number, keptBytes:number}|null>}
   */
  async cleanup(maxBytes) {
    if (!maxBytes || maxBytes <= 0) return null;
    let total = 0;
    const objects = [];
    let cursor;
    do {
      const listing = await this.bucket.list({
        prefix: "blobs/sha256/",
        cursor
      });
      for (const obj of listing.objects) {
        total += obj.size;
        objects.push(obj);
      }
      cursor = listing.truncated ? listing.cursor : void 0;
    } while (cursor);
    if (total <= maxBytes) {
      return { removed: 0, keptBytes: total };
    }
    objects.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());
    let removed = 0;
    const toDelete = [];
    for (const obj of objects) {
      if (total <= maxBytes) break;
      toDelete.push(obj.key);
      total -= obj.size;
      removed += 1;
    }
    for (let i = 0; i < toDelete.length; i += 1e3) {
      await this.bucket.delete(toDelete.slice(i, i + 1e3));
    }
    return { removed, keptBytes: total };
  }
};

// src/storage/memory.js
var MemoryStore = class {
  static {
    __name(this, "MemoryStore");
  }
  constructor() {
    this.blobs = /* @__PURE__ */ new Map();
    this.manifests = /* @__PURE__ */ new Map();
    this.tags = /* @__PURE__ */ new Map();
    this.origins = /* @__PURE__ */ new Map();
  }
  async hasBlob(digest) {
    return this.blobs.has(digest);
  }
  async putBlob(digest, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
    this.blobs.set(digest, bytes);
  }
  async getBlob(digest) {
    const bytes = this.blobs.get(digest);
    if (!bytes) return null;
    return {
      size: bytes.length,
      stream: new Response(bytes).body
    };
  }
  async deleteBlob(digest) {
    this.blobs.delete(digest);
  }
  async hasManifest(digest) {
    return this.manifests.has(digest);
  }
  async putManifest(digest, bytes, mediaType) {
    this.manifests.set(digest, { bytes, mediaType });
  }
  async getManifest(digest) {
    return this.manifests.get(digest) || null;
  }
  async setTag(repo, tag, digest) {
    if (!this.tags.has(repo)) this.tags.set(repo, /* @__PURE__ */ new Map());
    this.tags.get(repo).set(tag, digest);
  }
  async getTagDigest(repo, tag) {
    const map = this.tags.get(repo);
    return map ? map.get(tag) : void 0;
  }
  async listTags(repo) {
    const map = this.tags.get(repo);
    return map ? Array.from(map.keys()) : [];
  }
  async setOrigin(repo, registry) {
    this.origins.set(repo, registry);
  }
  async getOrigin(repo) {
    return this.origins.get(repo);
  }
  // استور درون‌حافظه‌ای cleanup دوره‌ای ندارد
  async cleanup() {
    return null;
  }
};

// src/services/registries.js
var DEFAULT_REGISTRIES = [
  "docker.arvancloud.ir",
  "docker.io",
  "ghcr.io",
  "registry.k8s.io",
  "quay.io",
  "gcr.io",
  "public.ecr.aws",
  "mcr.microsoft.com",
  "registry.gitlab.com",
  "nvcr.io",
  "registry.hub.docker.com",
  "icr.io",
  "registry.cn-hangzhou.aliyuncs.com"
];
function getRegistries(env = {}) {
  const raw = env.REGISTRIES_JSON;
  if (!raw) {
    return DEFAULT_REGISTRIES.slice();
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new Error(`\u0641\u0631\u0645\u062A REGISTRIES_JSON \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A: ${err.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("REGISTRIES_JSON \u0628\u0627\u06CC\u062F \u06CC\u06A9 \u0622\u0631\u0627\u06CC\u0647 \u063A\u06CC\u0631\u062E\u0627\u0644\u06CC \u0627\u0632 \u0631\u0634\u062A\u0647 (\u0646\u0627\u0645 \u0647\u0627\u0633\u062A \u0631\u062C\u06CC\u0633\u062A\u0631\u06CC) \u0628\u0627\u0634\u062F");
  }
  return list;
}
__name(getRegistries, "getRegistries");

// src/services/fetcher.js
var DEFAULT_TIMEOUT_MS = 6e4;
async function peekAndUnwrap(body) {
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      }
    });
  }
  const isGzip = first.value.length >= 2 && first.value[0] === 31 && first.value[1] === 139;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return isGzip ? source.pipeThrough(new DecompressionStream("gzip")) : source;
}
__name(peekAndUnwrap, "peekAndUnwrap");
async function fetchTarball(imageRef, options = {}) {
  const sourceBaseUrl = options.sourceBaseUrl || "https://dockerimagesave.akiel.dev/image";
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const url = `${sourceBaseUrl}?name=${encodeURIComponent(imageRef)}`;
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new Error(`\u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0633\u0631\u0648\u06CC\u0633 \u0645\u0646\u0628\u0639 \u0645\u0645\u06A9\u0646 \u0646\u0634\u062F: ${err.message}`);
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch (_) {
    }
    throw new Error(
      `\u0633\u0631\u0648\u06CC\u0633 \u0645\u0646\u0628\u0639 \u062A\u0635\u0648\u06CC\u0631 \u062E\u0637\u0627\u06CC ${res.status} \u0628\u0631\u06AF\u0631\u062F\u0627\u0646\u062F: ${body.slice(0, 300)}`
    );
  }
  if (!res.body) {
    throw new Error("\u0633\u0631\u0648\u06CC\u0633 \u0645\u0646\u0628\u0639 \u062A\u0635\u0648\u06CC\u0631 \u0628\u062F\u0646\u0647\u200C\u0627\u06CC \u0628\u0631\u0646\u06AF\u0631\u062F\u0627\u0646\u062F");
  }
  return peekAndUnwrap(res.body);
}
__name(fetchTarball, "fetchTarball");

// src/index.js
function parseBoolean(value, defaultValue = false) {
  if (value === void 0 || value === null || value === "") {
    return defaultValue;
  }
  return String(value).toLowerCase() === "true";
}
__name(parseBoolean, "parseBoolean");
function parseSize(value, defaultValue = 0) {
  if (value === void 0 || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toUpperCase();
  const matchm = normalized.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/);
  if (!matchm) {
    throw new Error(
      `CACHE_MAX_SIZE \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A: "${value}". \u0645\u062B\u0627\u0644 \u0645\u0639\u062A\u0628\u0631: 500MB\u060C 10GB\u060C 1TB`
    );
  }
  const multipliers = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };
  return Math.floor(Number(matchm[1]) * multipliers[matchm[2] || "B"]);
}
__name(parseSize, "parseSize");
var cachedRouter = null;
var cachedRouterEnv = null;
function getRouter(env) {
  if (cachedRouter && cachedRouterEnv === env) {
    return cachedRouter;
  }
  const cacheEnabled = parseBoolean(env.CACHE_ENABLED, false);
  const ttlSeconds = Number(env.TRANSIENT_TTL_SECONDS || 1800);
  let store;
  if (cacheEnabled) {
    if (!env.REGISTRY_BUCKET) {
      throw new Error(
        "CACHE_ENABLED=true \u0627\u0633\u062A \u0648\u0644\u06CC \u0628\u0627\u06CC\u0646\u062F\u06CC\u0646\u06AF REGISTRY_BUCKET \u062A\u0646\u0638\u06CC\u0645 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u062F\u0631 wrangler.jsonc \u0628\u062E\u0634 r2_buckets \u0631\u0627 \u0641\u0639\u0627\u0644 \u06A9\u0646\u06CC\u062F."
      );
    }
    store = new R2Store(env.REGISTRY_BUCKET);
  } else if (typeof caches !== "undefined" && caches.default) {
    store = new TransientStore(ttlSeconds);
  } else {
    store = new MemoryStore();
  }
  cachedRouter = createV2Router({
    store,
    cacheEnabled,
    getRegistries: /* @__PURE__ */ __name(() => getRegistries(env), "getRegistries"),
    fetchTarball: /* @__PURE__ */ __name((imageRef) => fetchTarball(imageRef, {
      sourceBaseUrl: env.SOURCE_BASE_URL,
      timeoutMs: Number(env.FETCH_TIMEOUT_MS || 6e4)
    }), "fetchTarball"),
    os: env.DEFAULT_PLATFORM_OS || "linux",
    arch: env.DEFAULT_PLATFORM_ARCH || "amd64"
  });
  cachedRouterEnv = env;
  return cachedRouter;
}
__name(getRouter, "getRouter");
function notFound() {
  return Response.json(
    { errors: [{ code: "NOT_FOUND", message: "\u0645\u0633\u06CC\u0631 \u06CC\u0627\u0641\u062A \u0646\u0634\u062F" }] },
    { status: 404 }
  );
}
__name(notFound, "notFound");
var src_default = {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
      let router;
      try {
        router = getRouter(env);
      } catch (err) {
        return Response.json(
          { errors: [{ code: "CONFIG_ERROR", message: err.message }] },
          { status: 500 }
        );
      }
      try {
        const response = await router(request);
        return response || notFound();
      } catch (err) {
        return Response.json(
          { errors: [{ code: "INTERNAL_ERROR", message: "\u062E\u0637\u0627\u06CC \u062F\u0627\u062E\u0644\u06CC \u0633\u0631\u0648\u0631" }] },
          { status: 500 }
        );
      }
    }
    return notFound();
  },
  /**
   * Cron Trigger — جایگزین setInterval نسخه Node.
   * فقط در حالت کش دائمی (R2) و وقتی CACHE_MAX_SIZE > 0 است کاری می‌کند.
   */
  async scheduled(event, env, ctx) {
    void event;
    const cacheEnabled = parseBoolean(env.CACHE_ENABLED, false);
    const maxBytes = parseSize(env.CACHE_MAX_SIZE, 0);
    if (!cacheEnabled || !maxBytes || !env.REGISTRY_BUCKET) {
      return;
    }
    const store = new R2Store(env.REGISTRY_BUCKET);
    ctx.waitUntil(store.cleanup(maxBytes));
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError2;

// .wrangler/tmp/bundle-hxZ7wy/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-hxZ7wy/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

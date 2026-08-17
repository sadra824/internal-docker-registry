'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const tar = require('tar-stream');

const { buildUpstreamName, isDigest, safeName, sha256Hex } = require('./reference');

const DOCKER_MANIFEST_V2 = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_CONFIG = 'application/vnd.docker.container.image.v1+json';
const DOCKER_LAYER_GZIP = 'application/vnd.docker.image.rootfs.diff.tar.gzip';

class ImageStore {
  constructor(options) {
    this.cacheDir = options.cacheDir;
    this.saveImageUrl = options.saveImageUrl;
    this.defaultRegistry = options.defaultRegistry || '';
    this.cacheTtlMs = Math.max(0, Number(options.cacheTtlSeconds || 0)) * 1000;
    this.upstreamTimeoutMs = Math.max(1000, Number(options.upstreamTimeoutMs || 120000));
    this.logger = options.logger || silentLogger();
    this.inflight = new Map();
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.blobRoot(), { recursive: true }),
      fsp.mkdir(this.imageRoot(), { recursive: true }),
      fsp.mkdir(this.tagIndexRoot(), { recursive: true }),
      fsp.mkdir(this.digestIndexRoot(), { recursive: true }),
      fsp.mkdir(this.tmpRoot(), { recursive: true })
    ]);
  }

  async ensureImage(localName, reference, context = {}) {
    const upstreamName = buildUpstreamName(localName, reference, this.defaultRegistry);
    const lockKey = `${localName}\n${reference}\n${upstreamName}`;

    this.logger.info('image.resolve', {
      requestId: context.requestId,
      localName,
      reference,
      upstreamName,
      defaultRegistry: this.defaultRegistry || null
    });

    if (!this.inflight.has(lockKey)) {
      this.logger.debug('image.inflight_create', {
        requestId: context.requestId,
        localName,
        reference,
        upstreamName
      });
      this.inflight.set(
        lockKey,
        this.#ensureImageUnshared(localName, reference, upstreamName, context).finally(() => {
          this.inflight.delete(lockKey);
        })
      );
    } else {
      this.logger.debug('image.inflight_join', {
        requestId: context.requestId,
        localName,
        reference,
        upstreamName
      });
    }

    return this.inflight.get(lockKey);
  }

  async getBlob(digest) {
    const parsed = parseSha256Digest(digest);
    if (!parsed) return null;

    const file = this.blobPath(digest);
    const stat = await statOrNull(file);
    if (!stat || !stat.isFile()) return null;

    return {
      digest,
      file,
      size: stat.size
    };
  }

  async #ensureImageUnshared(localName, reference, upstreamName, context) {
    const indexed = isDigest(reference)
      ? await this.#readDigestIndex(localName, reference)
      : await this.#readTagIndex(localName, reference);

    if (indexed) {
      const metadata = await this.#readMetadata(indexed.key);
      if (metadata && isDigest(reference)) {
        this.logger.info('image.cache_hit', {
          requestId: context.requestId,
          localName,
          reference,
          upstreamName: metadata.upstreamName,
          manifestDigest: metadata.manifest && metadata.manifest.digest
        });
        return metadata;
      }

      if (metadata && metadata.upstreamName === upstreamName && this.#isFresh(metadata, reference)) {
        this.logger.info('image.cache_hit', {
          requestId: context.requestId,
          localName,
          reference,
          upstreamName,
          manifestDigest: metadata.manifest && metadata.manifest.digest
        });
        return metadata;
      }

      this.logger.info('image.cache_stale_or_mismatch', {
        requestId: context.requestId,
        localName,
        reference,
        upstreamName,
        indexedKey: indexed.key,
        cachedUpstreamName: metadata && metadata.upstreamName,
        cachedAt: metadata && metadata.cachedAt
      });
    } else {
      this.logger.info('image.cache_miss', {
        requestId: context.requestId,
        localName,
        reference,
        upstreamName
      });
    }

    return this.#fetchAndCacheImage(localName, reference, upstreamName, context);
  }

  #isFresh(metadata, reference) {
    if (isDigest(reference) || this.cacheTtlMs === 0) return true;
    return Date.now() - new Date(metadata.cachedAt).getTime() < this.cacheTtlMs;
  }

  async #fetchAndCacheImage(localName, reference, upstreamName, context) {
    const key = sha256Hex(`${localName}\n${reference}\n${upstreamName}`);
    const tmpDir = path.join(this.tmpRoot(), `${key}-${process.pid}-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });

    try {
      const sourceUrl = `${this.saveImageUrl}?name=${encodeURIComponent(upstreamName)}`;
      this.logger.info('upstream.fetch_start', {
        requestId: context.requestId,
        localName,
        reference,
        upstreamName,
        sourceUrl
      });

      const response = await fetch(sourceUrl, {
        signal: AbortSignal.timeout(this.upstreamTimeoutMs),
        headers: {
          'user-agent': 'docker-save-registry-proxy/1.0'
        }
      }).catch((error) => {
        this.logger.error('upstream.fetch_failed', {
          requestId: context.requestId,
          upstreamName,
          sourceUrl,
          timeoutMs: this.upstreamTimeoutMs,
          error
        });
        throw error;
      });

      this.logger.info('upstream.fetch_response', {
        requestId: context.requestId,
        upstreamName,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length')
      });

      if (!response.ok || !response.body) {
        const details = await safeReadResponseText(response);
        throw new Error(`upstream returned ${response.status} ${response.statusText}${details ? `: ${details}` : ''}`);
      }

      const extracted = await this.#extractDockerSave(response.body, tmpDir, context);
      const dockerSaveManifest = JSON.parse(requiredJson(extracted.jsonFiles, 'manifest.json').toString('utf8'));

      if (!Array.isArray(dockerSaveManifest) || dockerSaveManifest.length === 0) {
        throw new Error('docker save tar does not contain a usable manifest.json');
      }

      const savedImage = pickSavedImage(dockerSaveManifest, upstreamName);
      this.logger.debug('docker_save.manifest_selected', {
        requestId: context.requestId,
        upstreamName,
        config: savedImage.Config,
        repoTags: savedImage.RepoTags,
        layerCount: Array.isArray(savedImage.Layers) ? savedImage.Layers.length : 0
      });

      const configBuffer = requiredJson(extracted.jsonFiles, savedImage.Config);
      const configBlob = await this.#storeBufferBlob(configBuffer);

      const layers = [];
      for (const layerPath of savedImage.Layers || []) {
        const layer = extracted.layers.get(normalizeTarPath(layerPath));
        if (!layer) {
          throw new Error(`docker save tar is missing layer ${layerPath}`);
        }

        const storedLayer = await this.#moveBlobIntoStore(layer.file, layer.digest);
        layers.push({
          mediaType: DOCKER_LAYER_GZIP,
          size: storedLayer.size,
          digest: layer.digest
        });
      }

      const manifestObject = {
        schemaVersion: 2,
        mediaType: DOCKER_MANIFEST_V2,
        config: {
          mediaType: DOCKER_CONFIG,
          size: configBlob.size,
          digest: configBlob.digest
        },
        layers
      };

      const manifestBuffer = Buffer.from(JSON.stringify(manifestObject), 'utf8');
      const manifestDigest = digestBuffer(manifestBuffer);
      const imageDir = path.join(this.imageRoot(), key);
      await fsp.mkdir(imageDir, { recursive: true });
      const manifestFile = path.join(imageDir, 'manifest.json');
      await fsp.writeFile(manifestFile, manifestBuffer);

      const metadata = {
        key,
        localName,
        reference,
        upstreamName,
        cachedAt: new Date().toISOString(),
        manifest: {
          digest: manifestDigest.digest,
          file: manifestFile,
          mediaType: DOCKER_MANIFEST_V2,
          size: manifestBuffer.length
        },
        config: {
          digest: configBlob.digest,
          size: configBlob.size
        },
        layers
      };

      await fsp.writeFile(path.join(imageDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
      await this.#writeTagIndex(localName, reference, key);
      await this.#writeDigestIndex(localName, manifestDigest.digest, key);

      this.logger.info('image.cache_write', {
        requestId: context.requestId,
        localName,
        reference,
        upstreamName,
        manifestDigest: manifestDigest.digest,
        manifestSize: manifestBuffer.length,
        configDigest: configBlob.digest,
        layerCount: layers.length
      });

      return metadata;
    } finally {
      this.logger.debug('image.tmp_cleanup', {
        requestId: context.requestId,
        tmpDir
      });
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async #extractDockerSave(readableWebStream, tmpDir, context) {
    const extract = tar.extract();
    const jsonFiles = new Map();
    const layers = new Map();
    const entryPromises = [];

    this.logger.debug('docker_save.extract_start', {
      requestId: context.requestId,
      tmpDir
    });

    extract.on('entry', (header, stream, next) => {
      const entryName = normalizeTarPath(header.name);

      if (header.type !== 'file') {
        stream.resume();
        stream.on('end', next);
        return;
      }

      if (entryName === 'manifest.json' || entryName.endsWith('.json')) {
        const promise = readLimitedStream(stream, 20 * 1024 * 1024)
          .then((buffer) => {
            jsonFiles.set(entryName, buffer);
          })
          .then(next, next);
        entryPromises.push(promise);
        return;
      }

      if (entryName === 'layer.tar' || entryName.endsWith('/layer.tar')) {
        const outFile = path.join(tmpDir, `${safeName(entryName)}.tar.gz`);
        const promise = gzipToDigestFile(stream, outFile)
          .then((blob) => {
            layers.set(entryName, blob);
          })
          .then(next, next);
        entryPromises.push(promise);
        return;
      }

      stream.resume();
      stream.on('end', next);
    });

    await pipeline(await maybeGunzip(readableWebStream), extract);
    await Promise.all(entryPromises);

    this.logger.info('docker_save.extract_done', {
      requestId: context.requestId,
      jsonFileCount: jsonFiles.size,
      layerCount: layers.size
    });

    return {
      jsonFiles,
      layers
    };
  }

  async #storeBufferBlob(buffer) {
    const digest = digestBuffer(buffer).digest;
    const file = this.blobPath(digest);
    const existing = await statOrNull(file);
    if (!existing) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmpFile, buffer);
      await renameOrRemoveExisting(tmpFile, file);
    }

    return {
      digest,
      size: buffer.length,
      file
    };
  }

  async #moveBlobIntoStore(tmpFile, digest) {
    const file = this.blobPath(digest);
    const existing = await statOrNull(file);
    if (!existing) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await renameOrRemoveExisting(tmpFile, file);
    } else {
      await fsp.rm(tmpFile, { force: true });
    }

    const stat = await fsp.stat(file);
    return {
      digest,
      size: stat.size,
      file
    };
  }

  async #readMetadata(key) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.imageRoot(), key, 'metadata.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async #readTagIndex(localName, reference) {
    return readJsonOrNull(path.join(this.tagIndexRoot(), sha256Hex(localName), `${safeName(reference)}.json`));
  }

  async #writeTagIndex(localName, reference, key) {
    const file = path.join(this.tagIndexRoot(), sha256Hex(localName), `${safeName(reference)}.json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ key }));
  }

  async #readDigestIndex(localName, digest) {
    const parsed = parseSha256Digest(digest);
    if (!parsed) return null;
    return readJsonOrNull(path.join(this.digestIndexRoot(), sha256Hex(localName), `${parsed.hex}.json`));
  }

  async #writeDigestIndex(localName, digest, key) {
    const parsed = parseSha256Digest(digest);
    if (!parsed) return;
    const file = path.join(this.digestIndexRoot(), sha256Hex(localName), `${parsed.hex}.json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ key }));
  }

  blobRoot() {
    return path.join(this.cacheDir, 'blobs', 'sha256');
  }

  imageRoot() {
    return path.join(this.cacheDir, 'images');
  }

  tagIndexRoot() {
    return path.join(this.cacheDir, 'index', 'tags');
  }

  digestIndexRoot() {
    return path.join(this.cacheDir, 'index', 'digests');
  }

  tmpRoot() {
    return path.join(this.cacheDir, 'tmp');
  }

  blobPath(digest) {
    const parsed = parseSha256Digest(digest);
    if (!parsed) throw new Error(`unsupported digest ${digest}`);
    return path.join(this.blobRoot(), parsed.hex.slice(0, 2), parsed.hex);
  }
}

function normalizeTarPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function pickSavedImage(manifest, upstreamName) {
  const withoutDigestOrTag = repositoryFromReference(upstreamName);
  return (
    manifest.find((item) => Array.isArray(item.RepoTags) && item.RepoTags.includes(upstreamName)) ||
    manifest.find((item) => Array.isArray(item.RepoTags) && item.RepoTags.some((tag) => tag.startsWith(`${withoutDigestOrTag}:`))) ||
    manifest[0]
  );
}

function repositoryFromReference(reference) {
  const digestIndex = reference.indexOf('@');
  if (digestIndex !== -1) return reference.slice(0, digestIndex);

  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  return lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
}

function requiredJson(jsonFiles, name) {
  const normalized = normalizeTarPath(name);
  const file = jsonFiles.get(normalized);
  if (!file) throw new Error(`docker save tar is missing ${name}`);
  return file;
}

function digestBuffer(buffer) {
  const hex = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    digest: `sha256:${hex}`,
    hex
  };
}

async function gzipToDigestFile(readable, file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });

  await pipeline(readable, zlib.createGzip({ level: 6 }), meter, fs.createWriteStream(file));
  const hex = hash.digest('hex');

  return {
    digest: `sha256:${hex}`,
    file,
    size
  };
}

async function readLimitedStream(readable, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`tar json entry is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function maybeGunzip(readableWebStream) {
  const nodeStream =
    typeof readableWebStream.getReader === 'function'
      ? Readable.fromWeb(readableWebStream)
      : readableWebStream;
  const iterator = nodeStream[Symbol.asyncIterator]();
  const first = await iterator.next();

  async function* replay() {
    if (!first.done) yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  const stream = Readable.from(replay());
  if (first.done) return stream;

  const chunk = Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value);
  return chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b
    ? stream.pipe(zlib.createGunzip())
    : stream;
}

function parseSha256Digest(digest) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest);
  if (!match) return null;
  return {
    hex: match[1].toLowerCase()
  };
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

async function renameOrRemoveExisting(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
      await fsp.rm(from, { force: true });
      return;
    }
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function safeReadResponseText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

module.exports = {
  DOCKER_MANIFEST_V2,
  ImageStore
};

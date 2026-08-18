'use strict';

require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const { DOCKER_MANIFEST_V2, ImageStore } = require('./image-store');
const { createLogger } = require('./logger');
const { parseRegistryRequest } = require('./reference');

const PORT = Number(process.env.APP_PORT || process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_URL = process.env.APP_URL || 'localhost';
const PUBLIC_REGISTRY = `${APP_URL}:${PORT}`;
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(process.cwd(), 'data', 'cache'));
const SAVE_IMAGE_URL = process.env.SAVE_IMAGE_URL || 'https://dockerimagesave.akiel.dev/image';
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 3600);
const DEFAULT_REGISTRY = process.env.DEFAULT_REGISTRY || '';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = createLogger({ level: LOG_LEVEL });

const store = new ImageStore({
  cacheDir: CACHE_DIR,
  saveImageUrl: SAVE_IMAGE_URL,
  cacheTtlSeconds: CACHE_TTL_SECONDS,
  defaultRegistry: DEFAULT_REGISTRY,
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  logger
});

async function main() {
  console.log(process.env);
  await store.init();

  const server = http.createServer((req, res) => {
    const requestId = randomUUID().slice(0, 8);
    const startedAt = Date.now();

    logger.info('request.start', {
      requestId,
      method: req.method,
      url: req.url,
      host: req.headers.host,
      accept: req.headers.accept,
      userAgent: req.headers['user-agent'],
      remoteAddress: req.socket.remoteAddress,
      remoteFamily: req.socket.remoteFamily
    });

    res.on('finish', () => {
      logger.info('request.finish', {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    });

    handleRequest(req, res, requestId).catch((error) => {
      logger.error('request.error', { requestId, error });
      sendRegistryError(res, 500, 'UNKNOWN', error.message || 'internal server error');
    });
  });

  server.on('error', (error) => {
    logger.error('server.error', {
      error,
      host: HOST,
      port: PORT
    });
    process.exitCode = 1;
  });

  server.on('clientError', (error, socket) => {
    logger.warn('server.client_error', {
      error,
      remoteAddress: socket.remoteAddress,
      remoteFamily: socket.remoteFamily,
      remotePort: socket.remotePort,
      firstBytesHex: error.rawPacket ? error.rawPacket.subarray(0, 16).toString('hex') : null
    });

    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info('server.ready', {
      listenUrl: `http://${HOST}:${PORT}`,
      appUrl: APP_URL,
      dockerPullBase: PUBLIC_REGISTRY,
      cacheDir: CACHE_DIR,
      defaultRegistry: DEFAULT_REGISTRY || null,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      logLevel: LOG_LEVEL
    });
  });
}

async function handleRequest(req, res, requestId) {

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    logger.debug('route.health', { requestId });
    sendJson(res, 200, { ok: true });
    return;
  }

  const route = parseRegistryRequest(url.pathname);
  if (!route) {
    logger.warn('route.unknown', { requestId, pathname: url.pathname });
    sendRegistryError(res, 404, 'NAME_UNKNOWN', 'unknown registry endpoint');
    return;
  }

  logger.debug('route.matched', { requestId, route });
  addRegistryHeaders(res);

  if (route.kind === 'base') {
    sendJson(res, 200, {});
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    logger.warn('method.not_allowed', { requestId, method: req.method, route });
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }

  if (route.kind === 'manifest') {
    await handleManifest(req, res, route, requestId);
    return;
  }

  if (route.kind === 'blob') {
    await handleBlob(req, res, route, requestId);
  }
}

async function handleManifest(req, res, route, requestId) {
  let image;
  try {
    logger.info('manifest.resolve', {
      requestId,
      name: route.name,
      reference: route.reference
    });
    image = await store.ensureImage(route.name, route.reference, { requestId });
  } catch (error) {
    logger.error('manifest.resolve_failed', {
      requestId,
      name: route.name,
      reference: route.reference,
      error
    });
    sendRegistryError(res, 404, 'MANIFEST_UNKNOWN', error.message || 'manifest unknown');
    return;
  }

  logger.info('manifest.serve', {
    requestId,
    name: route.name,
    reference: route.reference,
    digest: image.manifest.digest,
    size: image.manifest.size
  });

  const headers = {
    'content-type': DOCKER_MANIFEST_V2,
    'content-length': image.manifest.size,
    'docker-content-digest': image.manifest.digest,
    etag: `"${image.manifest.digest}"`
  };

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await pipeline(fs.createReadStream(image.manifest.file), res);
}

async function handleBlob(req, res, route, requestId) {
  logger.debug('blob.resolve', {
    requestId,
    name: route.name,
    digest: route.digest
  });

  const blob = await store.getBlob(route.digest);
  if (!blob) {
    logger.warn('blob.missing', {
      requestId,
      name: route.name,
      digest: route.digest
    });
    sendRegistryError(res, 404, 'BLOB_UNKNOWN', 'blob unknown');
    return;
  }

  logger.debug('blob.serve', {
    requestId,
    name: route.name,
    digest: blob.digest,
    size: blob.size
  });

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': blob.size,
    'docker-content-digest': blob.digest,
    etag: `"${blob.digest}"`
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await pipeline(fs.createReadStream(blob.file), res);
}

function addRegistryHeaders(res) {
  res.setHeader('docker-distribution-api-version', 'registry/2.0');
}

function sendJson(res, status, body) {
  addRegistryHeaders(res);
  const buffer = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': buffer.length
  });
  res.end(buffer);
}

function sendRegistryError(res, status, code, message) {
  sendJson(res, status, {
    errors: [
      {
        code,
        message
      }
    ]
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

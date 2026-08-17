'use strict';

const crypto = require('node:crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeName(value) {
  return Buffer.from(value).toString('base64url');
}

function isDigest(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(value);
}

function firstComponentLooksLikeRegistry(name) {
  const first = name.split('/')[0] || '';
  return first === 'localhost' || first.includes('.') || first.includes(':');
}

function buildUpstreamName(localName, reference, defaultRegistry) {
  const hasRegistry = firstComponentLooksLikeRegistry(localName);
  const upstreamRepository = buildUpstreamRepository(localName, defaultRegistry, hasRegistry);

  return isDigest(reference)
    ? `${upstreamRepository}@${reference}`
    : `${upstreamRepository}:${reference}`;
}

function buildUpstreamRepository(localName, defaultRegistry, hasRegistry) {
  if (!defaultRegistry || hasRegistry) return localName;

  const registry = defaultRegistry.replace(/\/+$/, '');
  if ((registry === 'docker.io' || registry === 'index.docker.io') && !localName.includes('/')) {
    return `${registry}/library/${localName}`;
  }

  return `${registry}/${localName}`;
}

function parseRegistryRequest(pathname) {
  if (pathname === '/v2/' || pathname === '/v2') {
    return { kind: 'base' };
  }

  if (!pathname.startsWith('/v2/')) {
    return null;
  }

  const rest = pathname.slice('/v2/'.length);
  const manifestMarker = '/manifests/';
  const blobMarker = '/blobs/';

  const manifestIndex = rest.indexOf(manifestMarker);
  if (manifestIndex !== -1) {
    const name = rest.slice(0, manifestIndex);
    const reference = rest.slice(manifestIndex + manifestMarker.length);
    if (!name || !reference) return null;
    return {
      kind: 'manifest',
      name: decodeURIComponent(name),
      reference: decodeURIComponent(reference)
    };
  }

  const blobIndex = rest.indexOf(blobMarker);
  if (blobIndex !== -1) {
    const name = rest.slice(0, blobIndex);
    const digest = rest.slice(blobIndex + blobMarker.length);
    if (!name || !digest) return null;
    return {
      kind: 'blob',
      name: decodeURIComponent(name),
      digest: decodeURIComponent(digest)
    };
  }

  return null;
}

module.exports = {
  buildUpstreamName,
  isDigest,
  parseRegistryRequest,
  safeName,
  sha256Hex
};

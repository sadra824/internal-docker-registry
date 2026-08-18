'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DEFAULT_OS = process.env.DEFAULT_PLATFORM_OS || 'linux';
const DEFAULT_ARCH = process.env.DEFAULT_PLATFORM_ARCH || 'amd64';

function sha256(buffer) {
    return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function digestToPath(digest) {
    // "sha256:abcd..." -> "sha256/abcd..."
    return digest.replace('sha256:', 'sha256/');
}

function isOciLayout(dir) {
    return (
        fs.existsSync(path.join(dir, 'oci-layout')) &&
        fs.existsSync(path.join(dir, 'index.json'))
    );
}

/**
 * فرمت جدید docker save (بر پایه OCI layout): blobs از قبل content-addressed هستن،
 * فقط باید کپی بشن به store و منیفست درست انتخاب بشه.
 */
async function convertOciLayout(dir, store) {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    let manifestDesc = index.manifests[0];
    if (!manifestDesc) {
        throw new Error('index.json هیچ منیفستی نداشت');
    }

    const isIndexType =
        manifestDesc.mediaType === 'application/vnd.oci.image.index.v1+json' ||
        manifestDesc.mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json';

    if (isIndexType) {
        const subIndexPath = path.join(dir, 'blobs', digestToPath(manifestDesc.digest));
        const subIndex = JSON.parse(fs.readFileSync(subIndexPath, 'utf8'));
        const match = subIndex.manifests.find(
            (m) => m.platform && m.platform.os === DEFAULT_OS && m.platform.architecture === DEFAULT_ARCH
        );
        manifestDesc = match || subIndex.manifests[0];
    }

    const manifestPath = path.join(dir, 'blobs', digestToPath(manifestDesc.digest));
    const manifestBuf = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBuf.toString('utf8'));

    const allDescriptors = [manifest.config, ...manifest.layers];
    for (const desc of allDescriptors) {
        const blobSrc = path.join(dir, 'blobs', digestToPath(desc.digest));
        const buf = fs.readFileSync(blobSrc);
        store.putBlob(desc.digest, buf);
    }

    const manifestDigest = sha256(manifestBuf);
    const mediaType = manifest.mediaType || 'application/vnd.oci.image.manifest.v1+json';
    store.putManifest(manifestDigest, manifestBuf, mediaType);

    return { digest: manifestDigest, mediaType };
}

/**
 * فرمت کلاسیک docker save: لایه‌ها tar فشرده‌نشده هستن و باید gzip بشن،
 * دایجست بلاب = sha256 بایت‌های فشرده‌شده، دایجست کانفیگ = sha256 بایت‌های خام JSON.
 */
async function convertDockerSave(dir, store) {
    const manifestListPath = path.join(dir, 'manifest.json');
    const manifestList = JSON.parse(fs.readFileSync(manifestListPath, 'utf8'));
    const entry = manifestList[0];
    if (!entry) {
        throw new Error('manifest.json ورودی نداشت');
    }

    const configBuf = fs.readFileSync(path.join(dir, entry.Config));
    const configDigest = sha256(configBuf);
    store.putBlob(configDigest, configBuf);

    const layers = [];
    for (const layerRelPath of entry.Layers) {
        const rawBuf = fs.readFileSync(path.join(dir, layerRelPath));
        const gzBuf = zlib.gzipSync(rawBuf, { level: 6 });
        const digest = sha256(gzBuf);
        store.putBlob(digest, gzBuf);
        layers.push({
            mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
            size: gzBuf.length,
            digest
        });
    }

    const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: {
            mediaType: 'application/vnd.docker.container.image.v1+json',
            size: configBuf.length,
            digest: configDigest
        },
        layers
    };

    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    const manifestDigest = sha256(manifestBuf);
    store.putManifest(manifestDigest, manifestBuf, manifest.mediaType);

    return { digest: manifestDigest, mediaType: manifest.mediaType };
}

async function convert(extractDir, store) {
    if (isOciLayout(extractDir)) {
        return convertOciLayout(extractDir, store);
    }
    if (fs.existsSync(path.join(extractDir, 'manifest.json'))) {
        return convertDockerSave(extractDir, store);
    }
    throw new Error('فرمت تصویر ناشناخته است (نه OCI layout و نه docker save کلاسیک)');
}

module.exports = { convert };
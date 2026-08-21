/**
 * تبدیل tarball (خروجی سرویس منبع) به ساختار رجیستری v2 — کاملاً استریمی.
 *
 * دو فرمت پشتیبانی می‌شود (مثل نسخه Node):
 *
 * ۱) OCI layout (فرمت جدید docker save):
 *    oci-layout + index.json + blobs/sha256/<hex>
 *    همه‌چیز از قبل content-addressed است؛ blobهای بزرگ مستقیم به store
 *    استریم می‌شوند و فقط JSONهای کوچک در حافظه می‌مانند. اگر تصویر
 *    multi-arch باشد، blobهای پلتفرم‌های دیگر بعد از انتخاب پلتفرم حذف می‌شوند.
 *
 * ۲) docker save کلاسیک:
 *    manifest.json + <Config>.json + لایه‌های tar فشرده‌نشده.
 *    لایه‌ها باید gzip شوند و digest از بایت‌های فشرده محاسبه شود؛
 *    به همین دلیل این مسیر بافرing لازم دارد و برای لایه‌های خیلی بزرگ
 *    (بیش از LEGACY_MAX_BYTES) خطای واضح می‌دهد.
 */

import { TarReader } from '../utils/tar.js';
import { sha256Digest } from '../utils/sha256.js';

const SMALL_BLOB_LIMIT = 8 * 1024 * 1024; // blobهای کوچک در حافظه نگه داشته می‌شوند
const LEGACY_MAX_BYTES = 96 * 1024 * 1024; // سقف بافر برای فرمت کلاسیک

const OCI_MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_MEDIA_TYPES = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json'
];

function isContentAddressedBlob(name) {
    return /^blobs\/sha256\/[0-9a-f]{64}$/.test(name);
}

function blobNameToDigest(name) {
    return `sha256:${name.slice('blobs/sha256/'.length)}`;
}

function digestToBlobName(digest) {
    return `blobs/sha256/${digest.replace('sha256:', '')}`;
}

function text(bytes) {
    return new TextDecoder().decode(bytes);
}

async function gzipBuffer(bytes) {
    const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * استریم tar را می‌خواند و blobها را در store می‌نویسد؛ در پایان
 * digest و mediaType منیفست رجیستری را برمی‌گرداند.
 *
 * @param {ReadableStream} tarStream استریم tar (در صورت لزوم از قبل gunzip شده)
 * @param {object} store یکی از MemoryStore / TransientStore / R2Store
 * @param {{os?: string, arch?: string}} options انتخاب پلتفرم برای تصاویر multi-arch
 */
export async function convertTarStream(tarStream, store, options = {}) {
    const os = options.os || 'linux';
    const arch = options.arch || 'amd64';

    const reader = new TarReader(tarStream);

    const smallFiles = new Map(); // name -> Uint8Array (JSONها و blobهای کوچک)
    const streamedBlobs = new Set(); // digestهای استریم‌شده به store
    let legacyBuffered = 0; // حجم کل بافرشده‌ی مسیر کلاسیک

    // ---------- گذر اول (و تنها): توزیع اعضا ----------
    for (;;) {
        const entry = await reader.next();
        if (!entry) break;

        const { name, size } = entry;

        // directoryها و اعضای خاص pax را رد کن
        if (entry.typeflag === '5' || entry.typeflag === 'x' || entry.typeflag === 'g') {
            await reader.readAll(); // discard
            continue;
        }

        if (isContentAddressedBlob(name) && size > SMALL_BLOB_LIMIT) {
            // blob بزرگ: مستقیم به store استریم شود (بدون بازه‌ی حافظه)
            const digest = blobNameToDigest(name);
            await store.putBlob(digest, reader.entryStream());
            streamedBlobs.add(digest);
            continue;
        }

        // بقیه (JSONها + اعضای فرمت کلاسیک): بافر با سقف محافظ
        if (size > LEGACY_MAX_BYTES || legacyBuffered + size > LEGACY_MAX_BYTES) {
            throw new Error(
                'لایه‌های بزرگِ فرمت کلاسیک docker save روی Worker پشتیبانی نمی‌شوند ' +
                '(حجم بافر بیش از حد مجاز است)؛ از فرمت OCI layout استفاده کنید'
            );
        }

        const bytes = await reader.readAll();
        smallFiles.set(name, bytes);
        legacyBuffered += bytes.length;
    }

    // ---------- انتخاب مسیر تبدیل ----------
    if (smallFiles.has('oci-layout') && smallFiles.has('index.json')) {
        return convertOciLayout(smallFiles, streamedBlobs, store, { os, arch });
    }

    if (smallFiles.has('manifest.json')) {
        return convertDockerSave(smallFiles, store);
    }

    throw new Error('فرمت تصویر ناشناخته است (نه OCI layout و نه docker save کلاسیک)');
}

/** blob را از بافر کوچک یا از store (اگر استریم شده) بردار */
async function getBufferedOrStreamed(smallFiles, streamedBlobs, store, digest) {
    const name = digestToBlobName(digest);
    if (smallFiles.has(name)) {
        return smallFiles.get(name);
    }
    if (streamedBlobs.has(digest)) {
        const blob = await store.getBlob(digest);
        if (!blob) throw new Error(`blob ${digest} بعد از نوشتن پیدا نشد`);
        return new Uint8Array(await new Response(blob.stream).arrayBuffer());
    }
    return null;
}

async function convertOciLayout(smallFiles, streamedBlobs, store, { os, arch }) {
    let index;
    try {
        index = JSON.parse(text(smallFiles.get('index.json')));
    } catch (err) {
        throw new Error(`index.json نامعتبر است: ${err.message}`);
    }

    let manifestDesc = index.manifests && index.manifests[0];
    if (!manifestDesc) {
        throw new Error('index.json هیچ منیفستی نداشت');
    }

    // اگر index روی manifest-list اشاره می‌کرد، پلتفرم هدف را انتخاب کن
    const isIndexType = INDEX_MEDIA_TYPES.includes(manifestDesc.mediaType);
    if (isIndexType) {
        const subIndexBytes = await getBufferedOrStreamed(
            smallFiles, streamedBlobs, store, manifestDesc.digest
        );
        if (!subIndexBytes) {
            throw new Error(`manifest list ${manifestDesc.digest} در tarball پیدا نشد`);
        }

        const subIndex = JSON.parse(text(subIndexBytes));
        const match = (subIndex.manifests || []).find(
            (m) => m.platform
                && m.platform.os === os
                && m.platform.architecture === arch
        );
        manifestDesc = match || subIndex.manifests[0];
        if (!manifestDesc) {
            throw new Error('manifest list ورودی نداشت');
        }
    }

    const manifestBytes = await getBufferedOrStreamed(
        smallFiles, streamedBlobs, store, manifestDesc.digest
    );
    if (!manifestBytes) {
        throw new Error(`منیفست ${manifestDesc.digest} در tarball پیدا نشد`);
    }

    let manifest;
    try {
        manifest = JSON.parse(text(manifestBytes));
    } catch (err) {
        throw new Error(`منیفست نامعتبر است: ${err.message}`);
    }

    // فقط descriptorهای ارجاع‌شده نگه داشته شوند؛ بقیه‌ی blobهای
    // استریم‌شده (پلتفرم‌های دیگر و غیره) حذف می‌شوند
    const keep = new Set();
    if (manifest.config && manifest.config.digest) keep.add(manifest.config.digest);
    for (const layer of manifest.layers || []) {
        if (layer.digest) keep.add(layer.digest);
    }

    for (const digest of keep) {
        const name = digestToBlobName(digest);
        if (smallFiles.has(name)) {
            await store.putBlob(digest, smallFiles.get(name));
        } else if (!streamedBlobs.has(digest)) {
            throw new Error(`blob ${digest} در tarball پیدا نشد`);
        }
    }

    for (const digest of streamedBlobs) {
        if (!keep.has(digest)) {
            await store.deleteBlob(digest); // در استورهای موقت no-op است
        }
    }

    const manifestDigest = await sha256Digest(manifestBytes);
    const mediaType = manifest.mediaType || OCI_MANIFEST_TYPE;
    await store.putManifest(manifestDigest, manifestBytes, mediaType);

    return { digest: manifestDigest, mediaType };
}

async function convertDockerSave(smallFiles, store) {
    let manifestList;
    try {
        manifestList = JSON.parse(text(smallFiles.get('manifest.json')));
    } catch (err) {
        throw new Error(`manifest.json نامعتبر است: ${err.message}`);
    }

    const entry = manifestList[0];
    if (!entry) {
        throw new Error('manifest.json ورودی نداشت');
    }

    // کانفیگ
    const configBuf = smallFiles.get(entry.Config);
    if (!configBuf) {
        throw new Error(`فایل کانفیگ ${entry.Config} در tarball پیدا نشد`);
    }
    const configDigest = await sha256Digest(configBuf);
    await store.putBlob(configDigest, configBuf);

    // لایه‌ها: gzip + digest از بایت‌های فشرده
    const layers = [];
    for (const layerPath of entry.Layers || []) {
        const rawBuf = smallFiles.get(layerPath);
        if (!rawBuf) {
            throw new Error(`لایه ${layerPath} در tarball پیدا نشد`);
        }

        const gzBuf = await gzipBuffer(rawBuf);
        const digest = await sha256Digest(gzBuf);
        await store.putBlob(digest, gzBuf);

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

    const manifestBuf = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestDigest = await sha256Digest(manifestBuf);
    await store.putManifest(manifestDigest, manifestBuf, manifest.mediaType);

    return { digest: manifestDigest, mediaType: manifest.mediaType };
}

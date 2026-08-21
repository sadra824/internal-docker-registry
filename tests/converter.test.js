/**
 * تست مبدل استریمی tar → store (هر دو فرمت OCI layout و docker save کلاسیک)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertTarStream } from '../src/services/converter.js';
import { MemoryStore } from '../src/storage/memory.js';
import { sha256Digest } from '../src/utils/sha256.js';
import { tarStream } from './helpers/tar-builder.js';

const encoder = new TextEncoder();
const json = (value) => encoder.encode(JSON.stringify(value));

function blobName(digest) {
    return `blobs/sha256/${digest.replace('sha256:', '')}`;
}

test('فرمت OCI layout: تبدیل و انتخاب پلتفرم', async () => {
    const configBytes = json({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
    const configDigest = await sha256Digest(configBytes);

    const layerBytes = encoder.encode('fake-layer-content-amd64');
    const layerDigest = await sha256Digest(layerBytes);

    const armLayerBytes = encoder.encode('fake-layer-content-arm64');
    const armLayerDigest = await sha256Digest(armLayerBytes);

    const amd64Manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', size: configBytes.length, digest: configDigest },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', size: layerBytes.length, digest: layerDigest }]
    };
    const amd64ManifestBytes = json(amd64Manifest);
    const amd64ManifestDigest = await sha256Digest(amd64ManifestBytes);

    const arm64Manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', size: 2, digest: 'sha256:' + 'a'.repeat(64) },
        layers: [{ size: armLayerBytes.length, digest: armLayerDigest }]
    };
    const arm64ManifestBytes = json(arm64Manifest);
    const arm64ManifestDigest = await sha256Digest(arm64ManifestBytes);

    const indexList = {
        schemaVersion: 2,
        manifests: [
            { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: amd64ManifestDigest, platform: { os: 'linux', architecture: 'amd64' } },
            { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: arm64ManifestDigest, platform: { os: 'linux', architecture: 'arm64' } }
        ]
    };
    const indexListBytes = json(indexList);
    const indexListDigest = await sha256Digest(indexListBytes);

    const indexJson = json({
        schemaVersion: 2,
        manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', digest: indexListDigest }]
    });

    const stream = tarStream([
        { name: 'oci-layout', data: json({ imageLayoutVersion: '1.0.0' }) },
        { name: 'index.json', data: indexJson },
        { name: blobName(indexListDigest), data: indexListBytes },
        { name: blobName(amd64ManifestDigest), data: amd64ManifestBytes },
        { name: blobName(arm64ManifestDigest), data: arm64ManifestBytes },
        { name: blobName(configDigest), data: configBytes },
        { name: blobName(layerDigest), data: layerBytes },
        { name: blobName(armLayerDigest), data: armLayerBytes }
    ]);

    const store = new MemoryStore();
    const result = await convertTarStream(stream, store, { os: 'linux', arch: 'amd64' });

    assert.equal(result.digest, amd64ManifestDigest);
    assert.equal(result.mediaType, 'application/vnd.oci.image.manifest.v1+json');

    // منیفست ذخیره شده؟
    const stored = await store.getManifest(result.digest);
    assert.ok(stored);
    assert.deepEqual(stored.bytes, amd64ManifestBytes);

    // blobهای ارجاع‌شده ذخیره شده‌اند؟
    assert.ok(await store.hasBlob(configDigest));
    assert.ok(await store.hasBlob(layerDigest));
});

test('فرمت docker save کلاسیک: gzip و digest لایه‌ها', async () => {
    const configBytes = json({ architecture: 'amd64', os: 'linux' });
    const configDigest = await sha256Digest(configBytes);

    const rawLayer = encoder.encode('uncompressed-layer-data'.repeat(50));

    const stream = tarStream([
        { name: 'manifest.json', data: json([{ Config: 'config.json', RepoTags: ['x'], Layers: ['layerid/layer.tar'] }]) },
        { name: 'config.json', data: configBytes },
        { name: 'layerid/layer.tar', data: rawLayer }
    ]);

    const store = new MemoryStore();
    const result = await convertTarStream(stream, store, {});

    // digest مورد انتظار: sha256 بایت‌های gzip شده
    const gzStream = new Blob([rawLayer]).stream().pipeThrough(new CompressionStream('gzip'));
    const gzBytes = new Uint8Array(await new Response(gzStream).arrayBuffer());
    const expectedLayerDigest = await sha256Digest(gzBytes);

    assert.ok(await store.hasBlob(configDigest));
    assert.ok(await store.hasBlob(expectedLayerDigest));

    const storedManifest = await store.getManifest(result.digest);
    const manifest = JSON.parse(new TextDecoder().decode(storedManifest.bytes));
    assert.equal(manifest.mediaType, 'application/vnd.docker.distribution.manifest.v2+json');
    assert.equal(manifest.layers[0].digest, expectedLayerDigest);
    assert.equal(manifest.layers[0].size, gzBytes.length);
});

test('فرمت ناشناخته باید خطا بدهد', async () => {
    const stream = tarStream([{ name: 'random.txt', data: 'hello' }]);
    await assert.rejects(
        () => convertTarStream(stream, new MemoryStore(), {}),
        /ناشناخته/
    );
});

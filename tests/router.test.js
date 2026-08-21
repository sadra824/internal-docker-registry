/**
 * تست روتر v2 — با store حافظه‌ای و fetchTarball ساختگی.
 * کل چرخه: manifest → fetch از upstream ساختگی → blob از store.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createV2Router } from '../src/routes/v2.js';
import { MemoryStore } from '../src/storage/memory.js';
import { sha256Digest } from '../src/utils/sha256.js';
import { tarStream } from './helpers/tar-builder.js';

const encoder = new TextEncoder();
const json = (value) => encoder.encode(JSON.stringify(value));

async function buildFakeImage() {
    const configBytes = json({ architecture: 'amd64', os: 'linux' });
    const configDigest = await sha256Digest(configBytes);

    const layerBytes = encoder.encode('router-test-layer');
    const layerDigest = await sha256Digest(layerBytes);

    const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', size: configBytes.length, digest: configDigest },
        layers: [{ size: layerBytes.length, digest: layerDigest }]
    };
    const manifestBytes = json(manifest);
    const manifestDigest = await sha256Digest(manifestBytes);

    const members = [
        { name: 'oci-layout', data: json({ imageLayoutVersion: '1.0.0' }) },
        { name: 'index.json', data: json({ schemaVersion: 2, manifests: [{ digest: manifestDigest }] }) },
        { name: `blobs/sha256/${manifestDigest.replace('sha256:', '')}`, data: manifestBytes },
        { name: `blobs/sha256/${configDigest.replace('sha256:', '')}`, data: configBytes },
        { name: `blobs/sha256/${layerDigest.replace('sha256:', '')}`, data: layerBytes }
    ];

    return {
        stream: () => tarStream(members),
        manifestDigest,
        configDigest,
        layerDigest,
        layerBytes
    };
}

function makeRouter(fakeImage, store) {
    return createV2Router({
        store,
        cacheEnabled: false,
        getRegistries: () => ['docker.io'],
        fetchTarball: async (imageRef) => {
            if (!imageRef.includes('nginx')) {
                throw new Error('not found');
            }
            return fakeImage.stream();
        },
        os: 'linux',
        arch: 'amd64'
    });
}

test('GET /v2/ → چک نسخه', async () => {
    const router = makeRouter(await buildFakeImage(), new MemoryStore());
    const res = await router(new Request('https://x.example/v2/'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Docker-Distribution-Api-Version'), 'registry/2.0');
    assert.deepEqual(await res.json(), {});
});

test('POST blobs/uploads → 501 (push پشتیبانی نمی‌شود)', async () => {
    const router = makeRouter(await buildFakeImage(), new MemoryStore());
    const res = await router(new Request('https://x.example/v2/myimg/blobs/uploads/', { method: 'POST' }));
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.errors[0].code, 'UNSUPPORTED');
});

test('چرخه کامل pull: manifest و blob', async () => {
    const fakeImage = await buildFakeImage();
    const router = makeRouter(fakeImage, new MemoryStore());

    // manifest با tag
    const manifestRes = await router(new Request('https://x.example/v2/library/nginx/manifests/latest'));
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers.get('Docker-Content-Digest'), fakeImage.manifestDigest);
    assert.equal(manifestRes.headers.get('Content-Type'), 'application/vnd.oci.image.manifest.v1+json');

    // blob لایه
    const blobRes = await router(new Request(`https://x.example/v2/library/nginx/blobs/${fakeImage.layerDigest}`));
    assert.equal(blobRes.status, 200);
    const blobBytes = new Uint8Array(await blobRes.arrayBuffer());
    assert.deepEqual(blobBytes, fakeImage.layerBytes);

    // manifest با digest (بعد از کش شدن)
    const digestRes = await router(new Request(`https://x.example/v2/library/nginx/manifests/${fakeImage.manifestDigest}`));
    assert.equal(digestRes.status, 200);

    // blob ناموجود
    const missingRes = await router(new Request('https://x.example/v2/library/nginx/blobs/sha256:' + '1'.repeat(64)));
    assert.equal(missingRes.status, 404);
    assert.equal((await missingRes.json()).errors[0].code, 'BLOB_UNKNOWN');
});

test('HEAD manifest → Content-Length بدون بدنه', async () => {
    const fakeImage = await buildFakeImage();
    const router = makeRouter(fakeImage, new MemoryStore());

    const res = await router(new Request('https://x.example/v2/library/nginx/manifests/latest', { method: 'HEAD' }));
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('Content-Length')) > 0);
});

test('tags/list در حالت بدون کش → خالی', async () => {
    const fakeImage = await buildFakeImage();
    const router = makeRouter(fakeImage, new MemoryStore());

    const res = await router(new Request('https://x.example/v2/library/nginx/tags/list'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'library/nginx', tags: [] });
});

test('ایمیج ناموجود → 404 با جزئیات رجیستری‌ها', async () => {
    const fakeImage = await buildFakeImage();
    const router = makeRouter(fakeImage, new MemoryStore());

    const res = await router(new Request('https://x.example/v2/library/doesnotexist/manifests/latest'));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.errors[0].code, 'MANIFEST_UNKNOWN');
    assert.match(body.errors[0].message, /docker\.io/);
});

test('مسیر ناشناخته → null (404 سطح بالا)', async () => {
    const router = makeRouter(await buildFakeImage(), new MemoryStore());
    const res = await router(new Request('https://x.example/v2/whatever/else'));
    assert.equal(res, null);
});

/**
 * تست روتر v2 در حالت استریم مستقیم — با fetchTarball ساختگی.
 * کل چرخه: manifest → digest → blob stream، به‌علاوه‌ی رفتار حافظه‌ی isolate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createV2Router } from '../src/routes/v2.js';
import { sha256Digest } from '../src/utils/sha256.js';
import { tarMember } from './helpers/tar-builder.js';

const encoder = new TextEncoder();
const json = (value) => encoder.encode(JSON.stringify(value));

function concat(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

async function buildFakeImage() {
    const configBytes = json({ architecture: 'amd64', os: 'linux' });
    const configHex = (await sha256Digest(configBytes)).replace('sha256:', '');

    const layerBytes = encoder.encode('stream-test-layer-content');
    const layerHex = (await sha256Digest(layerBytes)).replace('sha256:', '');

    // manifest.json فرمت docker save مبتنی بر OCI — digestها در مسیرها هستند
    const manifestJson = json([{
        Config: `blobs/sha256/${configHex}`,
        RepoTags: ['library/nginx:latest'],
        Layers: [`blobs/sha256/${layerHex}`]
    }]);

    const archive = concat([
        tarMember('manifest.json', manifestJson),
        tarMember(`blobs/sha256/${configHex}`, configBytes),
        tarMember(`blobs/sha256/${layerHex}`, layerBytes),
        new Uint8Array(1024)
    ]);

    return {
        archive,
        configBytes,
        layerBytes,
        configDigest: `sha256:${configHex}`,
        layerDigest: `sha256:${layerHex}`
    };
}

function makeRouter(fakeImage, opts = {}) {
    let fetchCount = 0;

    const router = createV2Router({
        getRegistries: () => ['docker.io'],
        fetchTarball: async (imageRef) => {
            fetchCount += 1;
            if (opts.failAll) {
                throw new Error('boom');
            }
            if (!imageRef.includes('nginx')) {
                throw new Error('not found');
            }
            return new Response(fakeImage.archive).body;
        }
    });

    return { router, getFetchCount: () => fetchCount };
}

test('GET /v2/ → چک نسخه', async () => {
    const { router } = makeRouter(await buildFakeImage());
    const res = await router(new Request('https://x.example/v2/'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Docker-Distribution-Api-Version'), 'registry/2.0');
    assert.deepEqual(await res.json(), {});
});

test('POST blobs/uploads → 501 (push پشتیبانی نمی‌شود)', async () => {
    const { router } = makeRouter(await buildFakeImage());
    const res = await router(new Request('https://x.example/v2/myimg/blobs/uploads/', { method: 'POST' }));
    assert.equal(res.status, 501);
    assert.equal((await res.json()).errors[0].code, 'UNSUPPORTED');
});

test('چرخه کامل pull استریمی', async () => {
    const fakeImage = await buildFakeImage();
    const { router } = makeRouter(fakeImage);

    // HEAD manifest — docker اول این را می‌فرستد
    const headRes = await router(new Request('https://x.example/v2/library/nginx/manifests/latest', { method: 'HEAD' }));
    assert.equal(headRes.status, 200);
    const manifestDigest = headRes.headers.get('Docker-Content-Digest');
    assert.ok(manifestDigest.startsWith('sha256:'));
    assert.ok(Number(headRes.headers.get('Content-Length')) > 0);

    // GET manifest — همان digest
    const manifestRes = await router(new Request('https://x.example/v2/library/nginx/manifests/latest'));
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers.get('Docker-Content-Digest'), manifestDigest);

    const manifest = await manifestRes.json();
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.config.digest, fakeImage.configDigest);
    assert.equal(manifest.layers[0].digest, fakeImage.layerDigest);
    assert.equal(manifest.layers[0].size, fakeImage.layerBytes.length);

    // GET manifest با digest (باز بر اساس حافظه‌ی isolate)
    const digestRes = await router(new Request(`https://x.example/v2/library/nginx/manifests/${manifestDigest}`));
    assert.equal(digestRes.status, 200);
    assert.equal(digestRes.headers.get('Docker-Content-Digest'), manifestDigest);

    // GET blob لایه — بایت‌ها دقیقاً همان باشند
    const blobRes = await router(new Request(`https://x.example/v2/library/nginx/blobs/${fakeImage.layerDigest}`));
    assert.equal(blobRes.status, 200);
    assert.equal(blobRes.headers.get('Content-Length'), String(fakeImage.layerBytes.length));
    const blobBytes = new Uint8Array(await blobRes.arrayBuffer());
    assert.deepEqual(blobBytes, fakeImage.layerBytes);

    // GET blob کانفیگ
    const configRes = await router(new Request(`https://x.example/v2/library/nginx/blobs/${fakeImage.configDigest}`));
    assert.equal(configRes.status, 200);
    assert.deepEqual(new Uint8Array(await configRes.arrayBuffer()), fakeImage.configBytes);

    // HEAD blob — فقط حجم
    const headBlobRes = await router(new Request(`https://x.example/v2/library/nginx/blobs/${fakeImage.layerDigest}`, { method: 'HEAD' }));
    assert.equal(headBlobRes.status, 200);
    assert.equal(headBlobRes.headers.get('Content-Length'), String(fakeImage.layerBytes.length));

    // blob ناموجود
    const missingRes = await router(new Request('https://x.example/v2/library/nginx/blobs/sha256:' + '1'.repeat(64)));
    assert.equal(missingRes.status, 404);
    assert.equal((await missingRes.json()).errors[0].code, 'BLOB_UNKNOWN');
});

test('حافظه‌ی isolate: blob بعد از manifest فقط یک fetch دیگر می‌خواهد', async () => {
    const fakeImage = await buildFakeImage();
    const { router, getFetchCount } = makeRouter(fakeImage);

    await router(new Request('https://x.example/v2/library/nginx/manifests/latest'));
    const afterManifest = getFetchCount();

    await router(new Request(`https://x.example/v2/library/nginx/blobs/${fakeImage.layerDigest}`));
    assert.equal(getFetchCount(), afterManifest + 1); // fetch برای پیدا کردن عضو tar

    // blob دوم (کانفیگ) هم یک fetch مستقل — چون هیچ ذخیره‌ای نداریم
    await router(new Request(`https://x.example/v2/library/nginx/blobs/${fakeImage.configDigest}`));
    assert.equal(getFetchCount(), afterManifest + 2);

    // manifest دوباره → از حافظه، بدون fetch جدید
    await router(new Request('https://x.example/v2/library/nginx/manifests/latest'));
    assert.equal(getFetchCount(), afterManifest + 2);
});

test('tags/list بدون ذخیره‌سازی → خالی', async () => {
    const { router } = makeRouter(await buildFakeImage());
    const res = await router(new Request('https://x.example/v2/library/nginx/tags/list'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'library/nginx', tags: [] });
});

test('ایمیج ناموجود → 404 با جزئیات رجیستری', async () => {
    const { router } = makeRouter(await buildFakeImage());
    const res = await router(new Request('https://x.example/v2/library/doesnotexist/manifests/latest'));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.errors[0].code, 'MANIFEST_UNKNOWN');
    assert.match(body.errors[0].message, /docker\.io/);
});

test('فرمت کلاسیک (مسیر غیر content-addressed) → خطای واضح', async () => {
    const manifestJson = json([{ Config: 'abc.json', Layers: ['layerid/layer.tar'] }]);
    const archive = concat([
        tarMember('manifest.json', manifestJson),
        tarMember('abc.json', json({})),
        tarMember('layerid/layer.tar', encoder.encode('raw')),
        new Uint8Array(1024)
    ]);

    const router = createV2Router({
        getRegistries: () => ['docker.io'],
        fetchTarball: async () => new Response(archive).body
    });

    const res = await router(new Request('https://x.example/v2/x/y/manifests/latest'));
    assert.equal(res.status, 404);
    const msg = (await res.json()).errors[0].message;
    assert.match(msg, /فرمت کلاسیک/);
});

test('مسیر ناشناخته → null (404 سطح بالا)', async () => {
    const { router } = makeRouter(await buildFakeImage());
    const res = await router(new Request('https://x.example/v2/whatever/else'));
    assert.equal(res, null);
});

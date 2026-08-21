/**
 * تست مسیر دانلود مستقیم (pass-through) — /image و /platforms
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPassthroughRouter } from '../src/routes/passthrough.js';

const encoder = new TextEncoder();

function makeRouter(fetchRaw, { registries = ['docker.arvancloud.ir', 'docker.io'] } = {}) {
    const calls = [];
    const wrapped = async (target, request) => {
        calls.push({ target, request });
        return fetchRaw(target, request, calls.length);
    };
    const router = createPassthroughRouter({
        getRegistries: () => registries.slice(),
        sourceBaseUrl: 'https://source.example/image',
        fetchRaw: wrapped
    });
    return { router, calls };
}

test('بدون پارامتر name → 400', async () => {
    const { router } = makeRouter(async () => new Response('x'));
    const res = await router(new Request('https://x.example/image'));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).errors[0].code, 'BAD_REQUEST');
});

test('fallback ترتیبی تا اولین رجیستری موفق', async () => {
    const { router, calls } = makeRouter(async (target, _req, n) => {
        if (n === 1) return new Response('not found', { status: 404 });
        return new Response('TARBALL-BYTES', {
            status: 200,
            headers: {
                'Content-Type': 'application/x-tar',
                'Content-Disposition': 'attachment; filename="nginx_latest.tar"',
                'Content-Length': '13'
            }
        });
    });

    const res = await router(new Request('https://x.example/image?name=nginx:latest'));

    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'TARBALL-BYTES');
    assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="nginx_latest.tar"');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls.length, 2);
    assert.match(calls[0].target, /name=docker\.arvancloud\.ir%2Fnginx%3Alatest/);
    assert.match(calls[1].target, /name=docker\.io%2Fnginx%3Alatest/);
});

test('نام با رجیستری صریح فقط همان‌جا امتحان می‌شود', async () => {
    const { router, calls } = makeRouter(async () => new Response('ok'));

    const res = await router(new Request('https://x.example/image?name=ghcr.io/owner/img:v1'));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].target, /name=ghcr\.io%2Fowner%2Fimg%3Av1/);
});

test('هدر Range برای resume پاس داده می‌شود و 206 حفظ می‌شود', async () => {
    const { router, calls } = makeRouter(async (target, request) => new Response('PART', {
        status: 206,
        headers: {
            'Content-Range': 'bytes 100-200/500',
            'Content-Length': '4'
        }
    }));

    const res = await router(new Request('https://x.example/image?name=a:1', {
        headers: { Range: 'bytes=100-200' }
    }));

    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), 'bytes 100-200/500');
    void calls;
});

test('پارامترهای os/arch.forward می‌شوند', async () => {
    const { router, calls } = makeRouter(async () => new Response('ok', { status: 200 }));

    await router(new Request('https://x.example/image?name=nginx:latest&os=linux&arch=arm64&variant=v8&foo=1'));

    assert.match(calls[0].target, /os=linux/);
    assert.match(calls[0].target, /arch=arm64/);
    assert.match(calls[0].target, /variant=v8/);
    assert.doesNotMatch(calls[0].target, /foo/);
});

test('/platforms مستقیم پاس داده می‌شود (بدون fallback)', async () => {
    const { router, calls } = makeRouter(async () => new Response('{"platforms":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    }));

    const res = await router(new Request('https://x.example/platforms?name=nginx:latest'));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /platforms/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].target, /\/platforms\?/);
});

test('شکست همه‌ی رجیستری‌ها → 502 با جزئیات', async () => {
    const { router } = makeRouter(async () => new Response('x', { status: 500 }));

    const res = await router(new Request('https://x.example/image?name=nope:1'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.errors[0].code, 'UPSTREAM_UNAVAILABLE');
    assert.match(body.errors[0].message, /docker\.io/);
    void encoder;
});

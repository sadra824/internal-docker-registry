/**
 * تست نرمال‌سازی نام ریپازیتوری (nginx → library/nginx)
 * این تست‌ها دقیقاً همان باگی را می‌گیرند که قبلاً _catalog را 500 کرد.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLibraryPrefix, requestWithLibraryPrefix } from '../src/lib/repository-name.js';

test('نام تک‌بخشی → پیشوند library', () => {
    assert.equal(
        withLibraryPrefix('/v2/nginx/manifests/latest'),
        '/v2/library/nginx/manifests/latest'
    );
    assert.equal(
        withLibraryPrefix('/v2/nginx/blobs/sha256:abc'),
        '/v2/library/nginx/blobs/sha256:abc'
    );
    assert.equal(
        withLibraryPrefix('/v2/nginx/tags/list'),
        '/v2/library/nginx/tags/list'
    );
});

test('نام‌های چندبخشی دست‌نخورده', () => {
    assert.equal(
        withLibraryPrefix('/v2/library/nginx/manifests/latest'),
        '/v2/library/nginx/manifests/latest'
    );
    assert.equal(
        withLibraryPrefix('/v2/sadra824/img/manifests/v1'),
        '/v2/sadra824/img/manifests/v1'
    );
    assert.equal(
        withLibraryPrefix('/v2/spiffe/spire-agent/manifests/1.15.2'),
        '/v2/spiffe/spire-agent/manifests/1.15.2'
    );
});

test('مسیرهای رزروشده و ریشه دست‌نخورده', () => {
    assert.equal(withLibraryPrefix('/v2/'), '/v2/');
    assert.equal(withLibraryPrefix('/v2'), '/v2');
    assert.equal(withLibraryPrefix('/v2/_catalog'), '/v2/_catalog');
    assert.equal(withLibraryPrefix('/'), '/');
    assert.equal(withLibraryPrefix('/image'), '/image');
});

test('سطح Request: فقط pathname عوض می‌شود، متد حفظ می‌شود', async () => {
    const req = new Request('https://x.example/v2/redis/tags/list', { method: 'HEAD' });
    const normalized = requestWithLibraryPrefix(req);

    assert.equal(normalized.url, 'https://x.example/v2/library/redis/tags/list');
    assert.equal(normalized.method, 'HEAD');

    // بدون تغییر → همان شیء برمی‌گردد
    const untouched = new Request('https://x.example/v2/_catalog');
    assert.equal(requestWithLibraryPrefix(untouched), untouched);
});

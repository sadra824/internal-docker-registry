/**
 * استور موقت بر پایه Cache API کلاودفلر — حالت پیش‌فرض (CACHE_ENABLED=false).
 *
 * شبیه حالت transient نسخه Node است:
 *  - هیچ ماندگاری «تضمین‌شده‌ای» وجود ندارد (best-effort، مخصوص لبه)
 *  - TTL از طریق Cache-Control کنترل می‌شود (پیش‌فرض ۳۰ دقیقه)
 *  - بدون setInterval — انقضا را خودِ Cache API انجام می‌دهد
 *
 * نکته: کلیدها URLهای مصنوعی هستند و از بیرون قابل دسترسی نیستند.
 */

const BASE = 'https://transient-registry.internal';

function blobUrl(digest) {
    return `${BASE}/blobs/${digest}`;
}

function manifestUrl(digest) {
    return `${BASE}/manifests/${digest}`;
}

function tagUrl(repo) {
    return `${BASE}/tags/${repo}`;
}

function originUrl(repo) {
    return `${BASE}/origins/${repo}`;
}

export class TransientStore {
    /**
     * @param {number} ttlSeconds عمر داده‌ها (پیش‌فرض ۱۸۰۰ ثانیه = ۳۰ دقیقه)
     */
    constructor(ttlSeconds = 1800) {
        this.cache = caches.default;
        this.ttl = `public, max-age=${Math.max(60, ttlSeconds | 0)}`;
    }

    async _get(url) {
        try {
            return await this.cache.match(new Request(url, { method: 'GET' }));
        } catch (_) {
            return undefined; // Cache API best-effort است
        }
    }

    async _put(url, body, headers = {}) {
        try {
            await this.cache.put(
                new Request(url, { method: 'GET' }),
                new Response(body, {
                    headers: {
                        'Cache-Control': this.ttl,
                        ...headers
                    }
                })
            );
        } catch (_) {
            // best-effort — اگر نشد ذخیره، درخواست بعدی دوباره fetch می‌کند
        }
    }

    async hasBlob(digest) {
        const hit = await this._get(blobUrl(digest));
        return Boolean(hit);
    }

    async putBlob(digest, data) {
        await this._put(blobUrl(digest), data);
    }

    async getBlob(digest) {
        const hit = await this._get(blobUrl(digest));
        if (!hit) return null;
        return {
            size: Number(hit.headers.get('x-blob-size') || 0),
            stream: hit.body
        };
    }

    // در استور موقت، حذف لازم نیست — TTL خودش تمیز می‌کند
    async deleteBlob() {
        return null;
    }

    async hasManifest(digest) {
        const hit = await this._get(manifestUrl(digest));
        return Boolean(hit);
    }

    async putManifest(digest, bytes, mediaType) {
        await this._put(manifestUrl(digest), bytes, {
            'Content-Type': 'application/json',
            'x-media-type': mediaType
        });
    }

    async getManifest(digest) {
        const hit = await this._get(manifestUrl(digest));
        if (!hit) return null;
        const bytes = new Uint8Array(await hit.arrayBuffer());
        return {
            bytes,
            mediaType: hit.headers.get('x-media-type')
                || 'application/vnd.oci.image.manifest.v1+json'
        };
    }

    async setTag(repo, tag, digest) {
        // نگاشت تکی tag → digest به‌صورت کلید مستقل
        await this._put(`${tagUrl(repo)}?tag=${encodeURIComponent(tag)}`, JSON.stringify({ digest }));
    }

    async getTagDigest(repo, tag) {
        const hit = await this._get(`${tagUrl(repo)}?tag=${encodeURIComponent(tag)}`);
        if (!hit) return undefined;
        try {
            const parsed = await hit.json();
            return parsed.digest;
        } catch (_) {
            return undefined;
        }
    }

    // مانند نسخه Node: در حالت بدون کش دائمی، فهرست تگ‌ها خالی است
    async listTags() {
        return [];
    }

    async setOrigin(repo, registry) {
        await this._put(originUrl(repo), JSON.stringify({ registry }));
    }

    async getOrigin(repo) {
        const hit = await this._get(originUrl(repo));
        if (!hit) return undefined;
        try {
            return (await hit.json()).registry;
        } catch (_) {
            return undefined;
        }
    }

    // بدون Cron/interval — انقضا با TTL انجام می‌شود
    async cleanup() {
        return null;
    }
}

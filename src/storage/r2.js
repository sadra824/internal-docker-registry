/**
 * استور دائمی بر پایه R2 — فقط وقتی CACHE_ENABLED=true فعال است.
 *
 * ساختار کلیدها:
 *   blobs/sha256/<hex>          ← بلاب‌ها (استریم نوشته/خوانده می‌شوند)
 *   manifests/<hex>             ← منیفست + mediaType در customMetadata
 *   tags/<repo>                 ← JSON نگاشت tag → digest
 *   origins/<repo>              ← رجیستری برنده (برای دیباگ)
 *
 * cleanup (اختیاری، با Cron Trigger): وقتی مجموع حجم blobها از
 * CACHE_MAX_SIZE بیشتر شود، قدیمی‌ترین‌ها (بر اساس زمان آپلود R2)
 * حذف می‌شوند. R2 زمان «آخرین دسترسی» ندارد؛ LRU واقعی نیازمند
 * بازنویسی metadata روی هر get است که هزینه‌ی write را دو برابر می‌کند؛
 * بنابراین سیاست، FIFO بر اساس uploaded است.
 */

function hexOf(digest) {
    return digest.replace('sha256:', '');
}

export class R2Store {
    /**
     * @param {R2Bucket} bucket بایندینگ env.REGISTRY_BUCKET
     */
    constructor(bucket) {
        this.bucket = bucket;
    }

    // ---------- Blobs ----------

    blobKey(digest) {
        return `blobs/sha256/${hexOf(digest)}`;
    }

    async hasBlob(digest) {
        try {
            const head = await this.bucket.head(this.blobKey(digest));
            return Boolean(head);
        } catch (_) {
            return false;
        }
    }

    async putBlob(digest, data) {
        // data: Uint8Array یا ReadableStream — R2 هر دو را می‌پذیرد
        await this.bucket.put(this.blobKey(digest), data);
    }

    async getBlob(digest) {
        const obj = await this.bucket.get(this.blobKey(digest));
        if (!obj) return null;
        return {
            size: obj.size,
            stream: obj.body
        };
    }

    async deleteBlob(digest) {
        await this.bucket.delete(this.blobKey(digest));
    }

    // ---------- Manifests ----------

    manifestKey(digest) {
        return `manifests/${hexOf(digest)}`;
    }

    async hasManifest(digest) {
        try {
            const head = await this.bucket.head(this.manifestKey(digest));
            return Boolean(head);
        } catch (_) {
            return false;
        }
    }

    async putManifest(digest, bytes, mediaType) {
        await this.bucket.put(this.manifestKey(digest), bytes, {
            customMetadata: { mediaType }
        });
    }

    async getManifest(digest) {
        const obj = await this.bucket.get(this.manifestKey(digest));
        if (!obj) return null;
        const bytes = new Uint8Array(await obj.arrayBuffer());
        return {
            bytes,
            mediaType: (obj.customMetadata && obj.customMetadata.mediaType)
                || 'application/vnd.oci.image.manifest.v1+json'
        };
    }

    // ---------- Tags ----------

    tagKey(repo) {
        return `tags/${repo}`;
    }

    async _readTags(repo) {
        const obj = await this.bucket.get(this.tagKey(repo));
        if (!obj) return {};
        try {
            return await obj.json();
        } catch (_) {
            return {};
        }
    }

    async setTag(repo, tag, digest) {
        const map = await this._readTags(repo);
        map[tag] = digest;
        await this.bucket.put(this.tagKey(repo), JSON.stringify(map));
    }

    async getTagDigest(repo, tag) {
        const map = await this._readTags(repo);
        return map[tag];
    }

    async listTags(repo) {
        const map = await this._readTags(repo);
        return Object.keys(map);
    }

    // ---------- Origins ----------

    async setOrigin(repo, registry) {
        await this.bucket.put(this.originKey(repo), JSON.stringify({ registry }));
    }

    originKey(repo) {
        return `origins/${repo}`;
    }

    async getOrigin(repo) {
        const obj = await this.bucket.get(this.originKey(repo));
        if (!obj) return undefined;
        try {
            return (await obj.json()).registry;
        } catch (_) {
            return undefined;
        }
    }

    // ---------- Cleanup (Cron Trigger) ----------

    /**
     * blobها را تا زیر maxBytes نگه می‌دارد — قدیمی‌ترین آپلودها اول حذف می‌شوند.
     * @returns {Promise<{removed:number, keptBytes:number}|null>}
     */
    async cleanup(maxBytes) {
        if (!maxBytes || maxBytes <= 0) return null;

        let total = 0;
        const objects = [];

        let cursor;
        do {
            const listing = await this.bucket.list({
                prefix: 'blobs/sha256/',
                cursor
            });

            for (const obj of listing.objects) {
                total += obj.size;
                objects.push(obj);
            }

            cursor = listing.truncated ? listing.cursor : undefined;
        } while (cursor);

        if (total <= maxBytes) {
            return { removed: 0, keptBytes: total };
        }

        objects.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());

        let removed = 0;
        const toDelete = [];
        for (const obj of objects) {
            if (total <= maxBytes) break;
            toDelete.push(obj.key);
            total -= obj.size;
            removed += 1;
        }

        // R2 حذف دسته‌ای تا ۱۰۰۰ کلید در هر فراخوانی
        for (let i = 0; i < toDelete.length; i += 1000) {
            await this.bucket.delete(toDelete.slice(i, i + 1000));
        }

        return { removed, keptBytes: total };
    }
}

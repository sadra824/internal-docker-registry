/**
 * استور درون‌حافظه‌ای — برای تست‌ها و به‌عنوان fallback.
 * هیچ ماندگاری بین isolateها ندارد.
 */

export class MemoryStore {
    constructor() {
        this.blobs = new Map(); // digest -> Uint8Array
        this.manifests = new Map(); // digest -> { bytes, mediaType }
        this.tags = new Map(); // repo -> Map(tag -> digest)
        this.origins = new Map(); // repo -> registry
    }

    async hasBlob(digest) {
        return this.blobs.has(digest);
    }

    async putBlob(digest, data) {
        const bytes = data instanceof Uint8Array
            ? data
            : new Uint8Array(await new Response(data).arrayBuffer());
        this.blobs.set(digest, bytes);
    }

    async getBlob(digest) {
        const bytes = this.blobs.get(digest);
        if (!bytes) return null;
        return {
            size: bytes.length,
            stream: new Response(bytes).body
        };
    }

    async deleteBlob(digest) {
        this.blobs.delete(digest);
    }

    async hasManifest(digest) {
        return this.manifests.has(digest);
    }

    async putManifest(digest, bytes, mediaType) {
        this.manifests.set(digest, { bytes, mediaType });
    }

    async getManifest(digest) {
        return this.manifests.get(digest) || null;
    }

    async setTag(repo, tag, digest) {
        if (!this.tags.has(repo)) this.tags.set(repo, new Map());
        this.tags.get(repo).set(tag, digest);
    }

    async getTagDigest(repo, tag) {
        const map = this.tags.get(repo);
        return map ? map.get(tag) : undefined;
    }

    async listTags(repo) {
        const map = this.tags.get(repo);
        return map ? Array.from(map.keys()) : [];
    }

    async setOrigin(repo, registry) {
        this.origins.set(repo, registry);
    }

    async getOrigin(repo) {
        return this.origins.get(repo);
    }

    // استور درون‌حافظه‌ای cleanup دوره‌ای ندارد
    async cleanup() {
        return null;
    }
}

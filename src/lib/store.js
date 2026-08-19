'use strict';

const fs = require('fs');
const path = require('path');

class Store {
    constructor(rootDir, options = {}) {
        this.root = rootDir;
        this.blobsDir = path.join(rootDir, 'blobs', 'sha256');
        this.manifestsDir = path.join(rootDir, 'manifests');
        this.tagsFile = path.join(rootDir, 'tags.json');
        this.originsFile = path.join(rootDir, 'origins.json');

        this.cacheEnabled = options.cacheEnabled !== false;
        this.maxSizeBytes = options.maxSizeBytes || 0;

        fs.mkdirSync(this.blobsDir, { recursive: true });
        fs.mkdirSync(this.manifestsDir, { recursive: true });

        this.tags = fs.existsSync(this.tagsFile)
            ? JSON.parse(fs.readFileSync(this.tagsFile, 'utf8'))
            : {};

        this.origins = fs.existsSync(this.originsFile)
            ? JSON.parse(fs.readFileSync(this.originsFile, 'utf8'))
            : {};
    }

    // ---------- Helpers ----------

    touch(filePath) {
        try {
            const now = new Date();
            fs.utimesSync(filePath, now, now);
        } catch (_) {
            // فایل ممکن است همزمان توسط cleanup حذف شده باشد
        }
    }

    fileSize(filePath) {
        try {
            return fs.statSync(filePath).size;
        } catch (_) {
            return 0;
        }
    }

    getCacheSize() {
        let total = 0;

        const walk = (dir) => {
            if (!fs.existsSync(dir)) return;

            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    walk(fullPath);
                } else {
                    total += this.fileSize(fullPath);
                }
            }
        };

        walk(this.root);

        return total;
    }

    // ---------- Blobs ----------

    blobPath(digest) {
        return path.join(this.blobsDir, digest.replace('sha256:', ''));
    }

    hasBlob(digest) {
        return fs.existsSync(this.blobPath(digest));
    }

    putBlob(digest, buffer) {
        if (!this.hasBlob(digest)) {
            fs.writeFileSync(this.blobPath(digest), buffer);
        }

        this.touch(this.blobPath(digest));
    }

    getBlob(digest) {
        const filePath = this.blobPath(digest);
        const buffer = fs.readFileSync(filePath);

        // آخرین استفاده برای LRU
        this.touch(filePath);

        return buffer;
    }

    // ---------- Manifests ----------

    manifestPath(digest) {
        return path.join(
            this.manifestsDir,
            digest.replace('sha256:', '') + '.json'
        );
    }

    manifestMetaPath(digest) {
        return this.manifestPath(digest) + '.meta';
    }

    hasManifest(digest) {
        return fs.existsSync(this.manifestPath(digest));
    }

    putManifest(digest, buffer, mediaType) {
        fs.writeFileSync(this.manifestPath(digest), buffer);
        fs.writeFileSync(
            this.manifestMetaPath(digest),
            JSON.stringify({ mediaType })
        );

        this.touch(this.manifestPath(digest));
        this.touch(this.manifestMetaPath(digest));
    }

    getManifest(digest) {
        const manifestPath = this.manifestPath(digest);
        const metaPath = this.manifestMetaPath(digest);

        const buffer = fs.readFileSync(manifestPath);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        // آخرین استفاده برای LRU
        this.touch(manifestPath);
        this.touch(metaPath);

        return {
            buffer,
            mediaType: meta.mediaType
        };
    }

    // ---------- Tags ----------

    setTag(repoName, tag, digest) {
        if (!this.tags[repoName]) {
            this.tags[repoName] = {};
        }

        this.tags[repoName][tag] = digest;

        fs.writeFileSync(
            this.tagsFile,
            JSON.stringify(this.tags, null, 2)
        );
    }

    getTagDigest(repoName, tag) {
        return this.tags[repoName] && this.tags[repoName][tag];
    }

    listTags(repoName) {
        return this.tags[repoName]
            ? Object.keys(this.tags[repoName])
            : [];
    }

    // ---------- Origins ----------

    setOrigin(repoName, registry) {
        this.origins[repoName] = registry;

        fs.writeFileSync(
            this.originsFile,
            JSON.stringify(this.origins, null, 2)
        );
    }

    getOrigin(repoName) {
        return this.origins[repoName];
    }

    // ---------- Cache cleanup ----------

    getManifestDigests() {
        if (!fs.existsSync(this.manifestsDir)) {
            return [];
        }

        return fs.readdirSync(this.manifestsDir)
            .filter((file) => file.endsWith('.json'))
            .map((file) => `sha256:${file.replace('.json', '')}`);
    }

    getManifestReferencedBlobs(digest) {
        if (!this.hasManifest(digest)) {
            return [];
        }

        try {
            const { buffer } = this.getManifest(digest);
            const manifest = JSON.parse(buffer.toString('utf8'));

            const digests = [];

            if (manifest.config && manifest.config.digest) {
                digests.push(manifest.config.digest);
            }

            if (Array.isArray(manifest.layers)) {
                for (const layer of manifest.layers) {
                    if (layer && layer.digest) {
                        digests.push(layer.digest);
                    }
                }
            }

            return digests;
        } catch (err) {
            console.error(
                `[cache] خطا در خواندن manifest ${digest}:`,
                err.message
            );

            return [];
        }
    }

    getReferencedBlobs() {
        const referenced = new Set();

        for (const digest of this.getManifestDigests()) {
            for (const blobDigest of this.getManifestReferencedBlobs(digest)) {
                referenced.add(blobDigest);
            }
        }

        return referenced;
    }

    deleteManifest(digest) {
        const manifestPath = this.manifestPath(digest);
        const metaPath = this.manifestMetaPath(digest);

        try {
            fs.unlinkSync(manifestPath);
        } catch (_) { }

        try {
            fs.unlinkSync(metaPath);
        } catch (_) { }

        // tagهایی که به این manifest اشاره می‌کنند حذف شوند
        for (const repoName of Object.keys(this.tags)) {
            for (const tag of Object.keys(this.tags[repoName])) {
                if (this.tags[repoName][tag] === digest) {
                    delete this.tags[repoName][tag];
                }
            }

            if (Object.keys(this.tags[repoName]).length === 0) {
                delete this.tags[repoName];
            }
        }
    }

    cleanup(maxSizeBytes = this.maxSizeBytes) {
        if (!this.cacheEnabled) {
            return {
                removed: false,
                size: this.getCacheSize()
            };
        }

        if (!maxSizeBytes || maxSizeBytes <= 0) {
            return {
                removed: false,
                size: this.getCacheSize()
            };
        }

        let currentSize = this.getCacheSize();

        if (currentSize <= maxSizeBytes) {
            return {
                removed: false,
                size: currentSize
            };
        }

        console.log(
            `[cache] حجم cache برابر ${currentSize} bytes است؛ ` +
            `حداکثر مجاز ${maxSizeBytes} bytes`
        );

        const manifests = this.getManifestDigests()
            .map((digest) => {
                const filePath = this.manifestPath(digest);

                let mtime = 0;

                try {
                    mtime = fs.statSync(filePath).mtimeMs;
                } catch (_) { }

                return {
                    digest,
                    mtime
                };
            })
            .sort((a, b) => a.mtime - b.mtime);

        let removedManifests = 0;

        // قدیمی‌ترین imageها حذف می‌شوند تا زیر سقف برگردیم.
        for (const item of manifests) {
            if (currentSize <= maxSizeBytes) {
                break;
            }

            if (!this.hasManifest(item.digest)) {
                continue;
            }

            this.deleteManifest(item.digest);
            removedManifests++;

            currentSize = this.getCacheSize();
        }

        // tags.json بعد از حذف tagها دوباره نوشته شود
        fs.writeFileSync(
            this.tagsFile,
            JSON.stringify(this.tags, null, 2)
        );

        // حالا blobهایی که دیگر هیچ manifestای به آنها اشاره نمی‌کند
        // قابل حذف هستند.
        const referencedBlobs = this.getReferencedBlobs();

        if (fs.existsSync(this.blobsDir)) {
            for (const file of fs.readdirSync(this.blobsDir)) {
                const digest = `sha256:${file}`;

                if (referencedBlobs.has(digest)) {
                    continue;
                }

                const filePath = path.join(this.blobsDir, file);

                try {
                    fs.unlinkSync(filePath);
                } catch (_) { }
            }
        }

        currentSize = this.getCacheSize();

        console.log(
            `[cache] cleanup انجام شد؛ ` +
            `${removedManifests} manifest حذف شد؛ ` +
            `حجم فعلی: ${currentSize} bytes`
        );

        return {
            removed: removedManifests > 0,
            removedManifests,
            size: currentSize
        };
    }
}

module.exports = Store;
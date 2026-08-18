'use strict';

const fs = require('fs');
const path = require('path');

class Store {
    constructor(rootDir) {
        this.root = rootDir;
        this.blobsDir = path.join(rootDir, 'blobs', 'sha256');
        this.manifestsDir = path.join(rootDir, 'manifests');
        this.tagsFile = path.join(rootDir, 'tags.json');

        fs.mkdirSync(this.blobsDir, { recursive: true });
        fs.mkdirSync(this.manifestsDir, { recursive: true });

        this.tags = fs.existsSync(this.tagsFile)
            ? JSON.parse(fs.readFileSync(this.tagsFile, 'utf8'))
            : {};
        this.originsFile = path.join(rootDir, 'origins.json');
        this.origins = fs.existsSync(this.originsFile)
            ? JSON.parse(fs.readFileSync(this.originsFile, 'utf8'))
            : {};
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
    }

    getBlob(digest) {
        return fs.readFileSync(this.blobPath(digest));
    }

    // ---------- Manifests ----------

    manifestPath(digest) {
        return path.join(this.manifestsDir, digest.replace('sha256:', '') + '.json');
    }

    manifestMetaPath(digest) {
        return this.manifestPath(digest) + '.meta';
    }

    hasManifest(digest) {
        return fs.existsSync(this.manifestPath(digest));
    }

    putManifest(digest, buffer, mediaType) {
        fs.writeFileSync(this.manifestPath(digest), buffer);
        fs.writeFileSync(this.manifestMetaPath(digest), JSON.stringify({ mediaType }));
    }

    getManifest(digest) {
        const buffer = fs.readFileSync(this.manifestPath(digest));
        const meta = JSON.parse(fs.readFileSync(this.manifestMetaPath(digest), 'utf8'));
        return { buffer, mediaType: meta.mediaType };
    }

    // ---------- Tags (repoName -> tag -> manifestDigest) ----------

    setTag(repoName, tag, digest) {
        if (!this.tags[repoName]) this.tags[repoName] = {};
        this.tags[repoName][tag] = digest;
        fs.writeFileSync(this.tagsFile, JSON.stringify(this.tags, null, 2));
    }

    getTagDigest(repoName, tag) {
        return this.tags[repoName] && this.tags[repoName][tag];
    }

    listTags(repoName) {
        return this.tags[repoName] ? Object.keys(this.tags[repoName]) : [];
    }
    // ---------- Origins (repoName -> رجیستری مبدایی که واقعاً جواب داد) ----------

    setOrigin(repoName, registry) {
        this.origins[repoName] = registry;
        fs.writeFileSync(this.originsFile, JSON.stringify(this.origins, null, 2));
    }

    getOrigin(repoName) {
        return this.origins[repoName];
    }
}

module.exports = Store;
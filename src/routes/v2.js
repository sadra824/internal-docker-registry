'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const { fetchAndExtract } = require('../lib/fetcher');
const { convert } = require('../lib/converter');
const { getRegistries } = require('../lib/registries');

function computeDigest(buffer) {
    return (
        'sha256:' +
        crypto.createHash('sha256').update(buffer).digest('hex')
    );
}

function buildV2Router(store, options = {}) {
    const router = express.Router();

    const cacheEnabled = options.cacheEnabled !== false;
    const maxSizeBytes = options.maxSizeBytes || 0;

    // جلوگیری از دانلود همزمان و تکراری یک image
    const pending = new Map();

    /*
     * وقتی CACHE_ENABLED=false باشد، imageها داخل store اصلی نوشته نمی‌شوند.
     * اما Docker برای manifest و blob چند request جداگانه می‌فرستد،
     * بنابراین temporary stores باید برای مدت کوتاهی نگه داشته شوند.
     */
    const transientStores = new Map();

    const TRANSIENT_TTL_MS = 30 * 60 * 1000;

    function createTransientStore() {
        const transientRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'docker-registry-transient-')
        );

        const Store = require('../lib/store');

        const transientStore = new Store(transientRoot, {
            cacheEnabled: false,
            maxSizeBytes: 0
        });

        return {
            root: transientRoot,
            store: transientStore,
            createdAt: Date.now(),
            lastAccess: Date.now()
        };
    }

    function cleanupTransientStores() {
        const now = Date.now();

        for (const [key, item] of transientStores.entries()) {
            if (
                now - item.lastAccess >
                TRANSIENT_TTL_MS
            ) {
                try {
                    fs.rmSync(item.root, {
                        recursive: true,
                        force: true
                    });
                } catch (_) { }

                transientStores.delete(key);

                console.log(
                    `[transient-cache] ${key} حذف شد`
                );
            }
        }
    }

    function touchTransient(key) {
        const item = transientStores.get(key);

        if (item) {
            item.lastAccess = Date.now();
        }
    }

    function createCacheKey(name, reference) {
        return `${name}:${reference}`;
    }

    function getStoreForImage(name, reference) {
        if (cacheEnabled) {
            return {
                store,
                transient: false
            };
        }

        const key = createCacheKey(name, reference);
        const item = transientStores.get(key);

        if (!item) {
            return null;
        }

        touchTransient(key);

        return {
            store: item.store,
            transient: true
        };
    }

    async function attemptRegistry(
        registry,
        name,
        reference,
        targetStore
    ) {
        const workDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'reg-')
        );

        try {
            const imageRef =
                `${registry}/${name}:${reference}`;

            console.log(
                `[fetch] تلاش برای ${imageRef} ...`
            );

            const extractDir =
                await fetchAndExtract(
                    imageRef,
                    workDir
                );

            const result =
                await convert(
                    extractDir,
                    targetStore
                );

            console.log(
                `[fetch] ${imageRef} پیدا شد ` +
                `(رجیستری برنده: ${registry})`
            );

            return {
                registry,
                digest: result.digest
            };
        } catch (err) {
            console.log(
                `[fetch] ${registry}/${name}:${reference} ` +
                `جواب نداد: ${err.message}`
            );

            throw new Error(
                `${registry}: ${err.message}`
            );
        } finally {
            fs.rmSync(workDir, {
                recursive: true,
                force: true
            });
        }
    }

    async function resolveManifest(
        name,
        reference
    ) {
        // -------------------------------
        // CACHE ENABLED
        // -------------------------------
        if (cacheEnabled) {
            if (
                reference.startsWith('sha256:') &&
                store.hasManifest(reference)
            ) {
                return store.getManifest(reference);
            }

            let digest =
                store.getTagDigest(
                    name,
                    reference
                );

            if (
                digest &&
                store.hasManifest(digest)
            ) {
                return store.getManifest(digest);
            }

            const key =
                createCacheKey(
                    name,
                    reference
                );

            if (!pending.has(key)) {
                const job = (async () => {
                    const registries =
                        getRegistries();

                    const attempts =
                        registries.map(
                            (registry) =>
                                attemptRegistry(
                                    registry,
                                    name,
                                    reference,
                                    store
                                )
                        );

                    let winner;

                    try {
                        winner =
                            await Promise.any(
                                attempts
                            );
                    } catch (aggregateErr) {
                        const details =
                            (
                                aggregateErr.errors ||
                                [aggregateErr]
                            )
                                .map(
                                    (e) => e.message
                                )
                                .join('\n');

                        throw new Error(
                            `ایمیج "${name}:${reference}" ` +
                            `در هیچ‌کدام از رجیستری‌های ` +
                            `registries.json پیدا نشد:\n` +
                            details
                        );
                    }

                    store.setTag(
                        name,
                        reference,
                        winner.digest
                    );

                    store.setOrigin(
                        name,
                        winner.registry
                    );

                    // بعد از اضافه شدن image، سقف cache را enforce کن.
                    if (maxSizeBytes > 0) {
                        store.cleanup(
                            maxSizeBytes
                        );
                    }

                    return winner.digest;
                })();

                pending.set(
                    key,
                    job.finally(() =>
                        pending.delete(key)
                    )
                );
            }

            digest =
                await pending.get(key);

            return store.getManifest(digest);
        }

        // -------------------------------
        // CACHE DISABLED
        // -------------------------------

        const key =
            createCacheKey(
                name,
                reference
            );

        let transient =
            transientStores.get(key);

        if (transient) {
            touchTransient(key);

            let digest =
                transient.store.getTagDigest(
                    name,
                    reference
                );

            if (
                digest &&
                transient.store.hasManifest(digest)
            ) {
                return transient.store.getManifest(
                    digest
                );
            }

            if (
                reference.startsWith('sha256:') &&
                transient.store.hasManifest(reference)
            ) {
                return transient.store.getManifest(
                    reference
                );
            }
        }

        if (!pending.has(key)) {
            const job = (async () => {
                const transientStore =
                    createTransientStore();

                transientStores.set(
                    key,
                    transientStore
                );

                const registries =
                    getRegistries();

                const attempts =
                    registries.map(
                        (registry) =>
                            attemptRegistry(
                                registry,
                                name,
                                reference,
                                transientStore.store
                            )
                    );

                let winner;

                try {
                    winner =
                        await Promise.any(
                            attempts
                        );
                } catch (aggregateErr) {
                    // چون image پیدا نشده، transient data هم لازم نیست
                    try {
                        fs.rmSync(
                            transientStore.root,
                            {
                                recursive: true,
                                force: true
                            }
                        );
                    } catch (_) { }

                    transientStores.delete(
                        key
                    );

                    const details =
                        (
                            aggregateErr.errors ||
                            [aggregateErr]
                        )
                            .map(
                                (e) => e.message
                            )
                            .join('\n');

                    throw new Error(
                        `ایمیج "${name}:${reference}" ` +
                        `در هیچ‌کدام از رجیستری‌های ` +
                        `registries.json پیدا نشد:\n` +
                        details
                    );
                }

                transientStore.store.setTag(
                    name,
                    reference,
                    winner.digest
                );

                transientStore.store.setOrigin(
                    name,
                    winner.registry
                );

                touchTransient(key);

                return {
                    store:
                        transientStore.store,
                    digest:
                        winner.digest
                };
            })();

            pending.set(
                key,
                job.finally(() =>
                    pending.delete(key)
                )
            );
        }

        const result =
            await pending.get(key);

        return result.store.getManifest(
            result.digest
        );
    }

    // GET /v2/
    router.get('/', (req, res) => {
        res.set(
            'Docker-Distribution-Api-Version',
            'registry/2.0'
        );

        res.json({});
    });

    router.get(
        '/healthz',
        (req, res) => res.send('ok')
    );

    // GET /v2/<name>/manifests/<reference>
    router.get(
        /^\/(.+)\/manifests\/([^/]+)$/,
        async (req, res) => {
            const name =
                req.params[0];

            const reference =
                req.params[1];

            try {
                const {
                    buffer,
                    mediaType
                } =
                    await resolveManifest(
                        name,
                        reference
                    );

                res.set(
                    'Content-Type',
                    mediaType
                );

                res.set(
                    'Docker-Content-Digest',
                    computeDigest(buffer)
                );

                res.set(
                    'Docker-Distribution-Api-Version',
                    'registry/2.0'
                );

                res.send(buffer);
            } catch (err) {
                console.error(
                    `[manifest] خطا برای ` +
                    `${name}:${reference} —`,
                    err.message
                );

                res.status(404).json({
                    errors: [
                        {
                            code:
                                'MANIFEST_UNKNOWN',
                            message:
                                err.message
                        }
                    ]
                });
            }
        }
    );

    // HEAD /v2/<name>/manifests/<reference>
    router.head(
        /^\/(.+)\/manifests\/([^/]+)$/,
        async (req, res) => {
            const name =
                req.params[0];

            const reference =
                req.params[1];

            try {
                const {
                    buffer,
                    mediaType
                } =
                    await resolveManifest(
                        name,
                        reference
                    );

                res.set(
                    'Content-Type',
                    mediaType
                );

                res.set(
                    'Docker-Content-Digest',
                    computeDigest(buffer)
                );

                res.set(
                    'Content-Length',
                    buffer.length
                );

                res.status(200).end();
            } catch (_) {
                res.status(404).end();
            }
        }
    );

    // GET /v2/<name>/blobs/<digest>
    router.get(
        /^\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/,
        (req, res) => {
            const digest =
                req.params[1];

            // اول cache دائمی
            if (
                cacheEnabled &&
                store.hasBlob(digest)
            ) {
                const buf =
                    store.getBlob(digest);

                res.set(
                    'Content-Type',
                    'application/octet-stream'
                );

                res.set(
                    'Docker-Content-Digest',
                    digest
                );

                return res.send(buf);
            }

            // در حالت CACHE_ENABLED=false
            // باید transient store مناسب را پیدا کنیم.
            if (!cacheEnabled) {
                for (
                    const [key, item]
                    of transientStores.entries()
                ) {
                    if (
                        item.store.hasBlob(
                            digest
                        )
                    ) {
                        touchTransient(key);

                        const buf =
                            item.store.getBlob(
                                digest
                            );

                        res.set(
                            'Content-Type',
                            'application/octet-stream'
                        );

                        res.set(
                            'Docker-Content-Digest',
                            digest
                        );

                        return res.send(buf);
                    }
                }
            }

            return res.status(404).json({
                errors: [
                    {
                        code:
                            'BLOB_UNKNOWN',
                        message:
                            digest
                    }
                ]
            });
        }
    );

    // HEAD /v2/<name>/blobs/<digest>
    router.head(
        /^\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/,
        (req, res) => {
            const digest =
                req.params[1];

            if (
                cacheEnabled &&
                store.hasBlob(digest)
            ) {
                const buf =
                    store.getBlob(digest);

                res.set(
                    'Content-Length',
                    buf.length
                );

                res.set(
                    'Docker-Content-Digest',
                    digest
                );

                return res.status(200).end();
            }

            if (!cacheEnabled) {
                for (
                    const [key, item]
                    of transientStores.entries()
                ) {
                    if (
                        item.store.hasBlob(
                            digest
                        )
                    ) {
                        touchTransient(key);

                        const buf =
                            item.store.getBlob(
                                digest
                            );

                        res.set(
                            'Content-Length',
                            buf.length
                        );

                        res.set(
                            'Docker-Content-Digest',
                            digest
                        );

                        return res.status(200).end();
                    }
                }
            }

            return res.status(404).end();
        }
    );

    // GET /v2/<name>/tags/list
    router.get(
        /^\/(.+)\/tags\/list$/,
        (req, res) => {
            const name =
                req.params[0];

            if (cacheEnabled) {
                return res.json({
                    name,
                    tags:
                        store.listTags(name)
                });
            }

            // در حالت بدون cache، tags دائمی نداریم.
            // برای این endpoint داده‌ای از upstream نداریم.
            return res.json({
                name,
                tags: []
            });
        }
    );

    // Push پشتیبانی نمی‌شود.
    router.post(
        /^\/(.+)\/blobs\/uploads\/?$/,
        (req, res) => {
            res.status(501).json({
                errors: [
                    {
                        code:
                            'UNSUPPORTED',
                        message:
                            'این رجیستری فقط از pull پشتیبانی می‌کند'
                    }
                ]
            });
        }
    );

    // cleanup temporary stores
    setInterval(
        cleanupTransientStores,
        5 * 60 * 1000
    );

    return router;
}

module.exports = buildV2Router;
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
    return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildV2Router(store) {
    const router = express.Router();

    // برای جلوگیری از دانلود همزمان و تکراری یک ایمیج توسط چند ریکوئست هم‌زمان
    const pending = new Map();

    // GET /v2/  -> چک نسخه API (ping) که docker اول از همه صداش می‌زنه
    router.get('/', (req, res) => {
        res.set('Docker-Distribution-Api-Version', 'registry/2.0');
        res.json({});
    });

    router.get('/healthz', (req, res) => res.send('ok'));

    /**
     * یک رجیستری مبدا رو امتحان می‌کنه: دانلود + استخراج + تبدیل.
     * فقط دیجست منیفست رو برمی‌گردونه؛ نوشتن tag/origin به عهدهٔ فراخوان (بعد از مشخص شدن برنده) است.
     */
    async function attemptRegistry(registry, name, reference) {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
        try {
            const imageRef = `${registry}/${name}:${reference}`;
            console.log(`[fetch] تلاش برای ${imageRef} ...`);
            const extractDir = await fetchAndExtract(imageRef, workDir);
            const result = await convert(extractDir, store);
            console.log(`[fetch] ${imageRef} پیدا شد (رجیستری برنده: ${registry})`);
            return { registry, digest: result.digest };
        } catch (err) {
            console.log(`[fetch] ${registry}/${name}:${reference} جواب نداد: ${err.message}`);
            throw new Error(`${registry}: ${err.message}`);
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }

    async function resolveManifest(name, reference) {
        if (reference.startsWith('sha256:') && store.hasManifest(reference)) {
            return store.getManifest(reference);
        }

        let digest = store.getTagDigest(name, reference);
        if (digest && store.hasManifest(digest)) {
            return store.getManifest(digest);
        }

        const key = `${name}:${reference}`;
        if (!pending.has(key)) {
            const job = (async () => {
                const registries = getRegistries();

                // همهٔ رجیستری‌ها هم‌زمان امتحان می‌شن؛ اولینی که موفق بشه برنده است
                const attempts = registries.map((registry) =>
                    attemptRegistry(registry, name, reference)
                );

                let winner;
                try {
                    winner = await Promise.any(attempts);
                } catch (aggregateErr) {
                    const details = (aggregateErr.errors || [aggregateErr])
                        .map((e) => e.message)
                        .join('\n');
                    throw new Error(
                        `ایمیج "${name}:${reference}" در هیچ‌کدام از رجیستری‌های registries.json پیدا نشد:\n${details}`
                    );
                }

                store.setTag(name, reference, winner.digest);
                store.setOrigin(name, winner.registry);
                return winner.digest;
            })();
            pending.set(key, job.finally(() => pending.delete(key)));
        }

        digest = await pending.get(key);
        return store.getManifest(digest);
    }

    // GET /v2/<name>/manifests/<reference>
    router.get(/^\/(.+)\/manifests\/([^/]+)$/, async (req, res) => {
        const name = req.params[0];
        const reference = req.params[1];
        try {
            const { buffer, mediaType } = await resolveManifest(name, reference);
            res.set('Content-Type', mediaType);
            res.set('Docker-Content-Digest', computeDigest(buffer));
            res.set('Docker-Distribution-Api-Version', 'registry/2.0');
            res.send(buffer);
        } catch (err) {
            console.error(`[manifest] خطا برای ${name}:${reference} —`, err.message);
            res.status(404).json({
                errors: [{ code: 'MANIFEST_UNKNOWN', message: err.message }]
            });
        }
    });

    // HEAD /v2/<name>/manifests/<reference>
    router.head(/^\/(.+)\/manifests\/([^/]+)$/, async (req, res) => {
        const name = req.params[0];
        const reference = req.params[1];
        try {
            const { buffer, mediaType } = await resolveManifest(name, reference);
            res.set('Content-Type', mediaType);
            res.set('Docker-Content-Digest', computeDigest(buffer));
            res.set('Content-Length', buffer.length);
            res.status(200).end();
        } catch (err) {
            res.status(404).end();
        }
    });

    // GET /v2/<name>/blobs/<digest>
    router.get(/^\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/, (req, res) => {
        const digest = req.params[1];
        if (!store.hasBlob(digest)) {
            return res.status(404).json({ errors: [{ code: 'BLOB_UNKNOWN', message: digest }] });
        }
        const buf = store.getBlob(digest);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Docker-Content-Digest', digest);
        res.send(buf);
    });

    // HEAD /v2/<name>/blobs/<digest>
    router.head(/^\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/, (req, res) => {
        const digest = req.params[1];
        if (!store.hasBlob(digest)) return res.status(404).end();
        const buf = store.getBlob(digest);
        res.set('Content-Length', buf.length);
        res.set('Docker-Content-Digest', digest);
        res.status(200).end();
    });

    // GET /v2/<name>/tags/list
    router.get(/^\/(.+)\/tags\/list$/, (req, res) => {
        const name = req.params[0];
        res.json({ name, tags: store.listTags(name) });
    });

    // آپلود (push) پیاده‌سازی نشده — این اپ فقط pull-through cache هست
    router.post(/^\/(.+)\/blobs\/uploads\/?$/, (req, res) => {
        res.status(501).json({
            errors: [{ code: 'UNSUPPORTED', message: 'این رجیستری فقط از pull پشتیبانی می‌کند' }]
        });
    });

    return router;
}

module.exports = buildV2Router;
/**
 * منطق اصلی رجیستری — مستقل از runtime (فقط Web API).
 *
 * resolveManifest(name, reference):
 *   ۱) جست‌وجوی مستقیم با digest
 *   ۲) جست‌وجوی tag از store
 *   ۳) دریافت از رجیستری‌های بالادستی از طریق سرویس منبع —
 *      به‌ترتیب و یکی‌یکی (اولین موفق برنده است).
 *      تلاش موازی روی Worker یعنی دانلود همزمانِ چند برابرِ ایمیج،
 *      CPU و پهنای‌باند بیشتر و پاسخ دیرتر؛ برای محیط request-driven
 *      مناسب نیست.
 */

import { convertTarStream } from './converter.js';

export function createRegistryService({
    store,
    getRegistries,
    fetchTarball,
    os = 'linux',
    arch = 'amd64'
}) {
    // فقط یک دانلود همزمان برای هر (name, reference) — مشترک بین درخواست‌های isolate
    const pending = new Map();

    function cacheKey(name, reference) {
        return `${name}:${reference}`;
    }

    async function attemptRegistry(registry, name, reference) {
        const imageRef = `${registry}/${name}:${reference}`;

        let stream;
        try {
            stream = await fetchTarball(imageRef);
        } catch (err) {
            throw new Error(`${registry}: ${err.message}`);
        }

        try {
            const result = await convertTarStream(stream, store, { os, arch });
            return { registry, digest: result.digest };
        } catch (err) {
            throw new Error(`${registry}: ${err.message}`);
        }
    }

    async function resolveManifest(name, reference) {
        // ۱) ارجاع مستقیم با digest
        if (
            reference.startsWith('sha256:')
            && await store.hasManifest(reference)
        ) {
            return store.getManifest(reference);
        }

        // ۲) ارجاع با tag
        const digest = await store.getTagDigest(name, reference);
        if (digest && await store.hasManifest(digest)) {
            return store.getManifest(digest);
        }

        // ۳) دریافت از upstream
        const key = cacheKey(name, reference);

        if (!pending.has(key)) {
            const job = (async () => {
                const registries = getRegistries();
                const failures = [];

                // به‌ترتیب: اولین رجیستری موفق برنده است
                let winner = null;
                for (const registry of registries) {
                    try {
                        winner = await attemptRegistry(registry, name, reference);
                        break;
                    } catch (err) {
                        failures.push(err.message);
                    }
                }

                if (!winner) {
                    throw new Error(
                        `ایمیج "${name}:${reference}" در هیچ‌کدام از رجیستری‌های ` +
                        `پیکربندی (REGISTRIES_JSON) پیدا نشد:\n${failures.join('\n')}`
                    );
                }

                await store.setTag(name, reference, winner.digest);
                await store.setOrigin(name, winner.registry);

                return { digest: winner.digest };
            })();

            pending.set(key, job.finally(() => pending.delete(key)));
        }

        const result = await pending.get(key);
        return store.getManifest(result.digest);
    }

    return { resolveManifest };
}

/**
 * منطق رجیستری در حالت «استریم مستقیم» — بدون ذخیره‌سازی و بدون پردازش سنگین:
 *
 *  - manifest: فقط متادیتای کوچک tarball (manifest.json + حجم اعضا) خوانده
 *    می‌شود؛ چون digestها در فرمت OCI داخل مسیر اعضا هستند
 *    (blobs/sha256/<hex>)، هیچ هشی محاسبه نمی‌شود. خواندن به‌محض کامل شدن
 *    متادیتا قطع می‌شود (اگر manifest.json ابتدای tarball باشد، فقط چند
 *    کیلوبایت خوانده می‌شود).
 *
 *  - blob: هدر پاسخ فوراً به کلاینت می‌رود و بایت‌های لایه همان‌طور که از
 *    سرویس منبع می‌رسند، بدون هیچ کپی یا پردازشی استریم می‌شوند.
 *
 *  - بین درخواست‌های یک isolate فقط متادیتای چند‌کیلوبایتی در حافظه نگه
 *    داشته می‌شود (نگاشت tag → منیفست با TTL) تا HEAD/GET منیفست و blobها
 *    لازم نباشد دوباره سراغ سرویس منبع بروند.
 *
 *  - تلاش رجیستری‌ها ترتیبی است: اولین رجیستری موفق برنده می‌شود.
 */

import { collectImageMeta, openTarMember } from './tarscan.js';
import { sha256Digest } from '../utils/sha256.js';

const MEMO_TTL_MS = 10 * 60 * 1000; // ۱۰ دقیقه
const MEMO_MAX_ENTRIES = 64;

const DOCKER_MANIFEST_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_CONFIG_TYPE = 'application/vnd.docker.container.image.v1+json';
const DOCKER_LAYER_TYPE = 'application/vnd.docker.image.rootfs.diff.tar.gzip';

const BLOB_PATH_RE = /^blobs\/sha256\/([0-9a-f]{64})$/;

export function createRegistryService({
    getRegistries,
    fetchTarball
}) {
    // حافظه‌ی isolate: key → { expiresAt, manifestBytes, manifestDigest,
    // mediaType, blobPaths: {digest → path} }
    const memo = new Map();

    function memoGet(key) {
        const hit = memo.get(key);
        if (!hit) return null;
        if (Date.now() > hit.expiresAt) {
            memo.delete(key);
            return null;
        }
        return hit;
    }

    function memoPut(key, value) {
        if (memo.size >= MEMO_MAX_ENTRIES) {
            // حذف قدیمی‌ترین
            const oldest = memo.keys().next().value;
            memo.delete(oldest);
        }
        memo.set(key, { ...value, expiresAt: Date.now() + MEMO_TTL_MS });
    }

    /** پیدا کردن entry حافظه بر اساس digest منیفست */
    function memoFindManifestByDigest(digest) {
        for (const value of memo.values()) {
            if (value.manifestDigest === digest) return value;
        }
        return null;
    }

    /**
     * پیدا کردن مرجع (tag) یک blob: درخواست blob فقط digest دارد؛ از حافظه‌ی
     * isolate دنبال ایمیجی می‌گردیم که این blob را ارجاع داده است.
     */
    function memoFindReferenceByBlob(name, digest) {
        for (const [key, value] of memo.entries()) {
            if (value.name === name && value.blobPaths && digest in value.blobPaths) {
                return value.reference;
            }
            void key;
        }
        return null;
    }

    /**
     * ساخت منیفست v2 از متادیتای tarball — فقط JSON کوچک + حجم اعضا.
     */
    async function buildManifest(name, reference) {
        const registries = getRegistries();
        const failures = [];

        for (const registry of registries) {
            const imageRef = `${registry}/${name}:${reference}`;
            let tarStream;
            try {
                tarStream = await fetchTarball(imageRef);
            } catch (err) {
                failures.push(`${registry}: ${err.message}`);
                continue;
            }

            try {
                const meta = await collectImageMeta(tarStream);

                if (!meta.manifestJson) {
                    throw new Error('tarball دارای manifest.json نیست (فرمت پشتیبانی نمی‌شود)');
                }

                let saveEntry;
                try {
                    saveEntry = JSON.parse(new TextDecoder().decode(meta.manifestJson))[0];
                } catch (err) {
                    throw new Error(`manifest.json نامعتبر است: ${err.message}`);
                }
                if (!saveEntry || !saveEntry.Config) {
                    throw new Error('manifest.json ورودی ندارد');
                }

                // فقط فرمت OCI (digest داخل مسیر) در حالت استریم ممکن است
                const configPath = saveEntry.Config;
                if (!BLOB_PATH_RE.test(configPath)) {
                    throw new Error(
                        'فرمت کلاسیک docker save پشتیبانی نمی‌شود ' +
                        '(مسیر بلاب‌ها content-addressed نیست)'
                    );
                }

                const layers = [];
                for (const layerPath of saveEntry.Layers || []) {
                    if (!BLOB_PATH_RE.test(layerPath)) {
                        throw new Error('مسیر لایه content-addressed نیست');
                    }
                    const size = meta.sizes.get(layerPath);
                    if (size === undefined) {
                        throw new Error(`لایه ${layerPath} در tarball پیدا نشد`);
                    }
                    layers.push({
                        mediaType: DOCKER_LAYER_TYPE,
                        size,
                        digest: `sha256:${layerPath.slice('blobs/sha256/'.length)}`
                    });
                }

                const configSize = meta.sizes.get(configPath);
                if (configSize === undefined) {
                    throw new Error(`کانفیگ ${configPath} در tarball پیدا نشد`);
                }

                const manifest = {
                    schemaVersion: 2,
                    mediaType: DOCKER_MANIFEST_TYPE,
                    config: {
                        mediaType: DOCKER_CONFIG_TYPE,
                        size: configSize,
                        digest: `sha256:${configPath.slice('blobs/sha256/'.length)}`
                    },
                    layers
                };

                const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
                const manifestDigest = await sha256Digest(manifestBytes);

                const blobPaths = {};
                blobPaths[manifest.config.digest] = configPath;
                for (const layer of layers) {
                    blobPaths[layer.digest] = `blobs/sha256/${layer.digest.replace('sha256:', '')}`;
                }

                return {
                    registry,
                    name,
                    reference,
                    manifestBytes,
                    manifestDigest,
                    mediaType: manifest.mediaType,
                    blobPaths
                };
            } catch (err) {
                failures.push(`${registry}: ${err.message}`);
            }
        }

        throw new Error(
            `ایمیج "${name}:${reference}" از رجیستری‌های پیکربندی (REGISTRIES_JSON) ` +
            `قابل دریافت نبود:\n${failures.join('\n')}`
        );
    }

    async function resolveManifest(name, reference) {
        const key = `${name}:${reference}`;
        let entry = memoGet(key);

        // ارجاع با digest: شاید با tag دیگری همین isolate ذخیره شده باشد
        if (!entry && reference.startsWith('sha256:')) {
            entry = memoFindManifestByDigest(reference);
        }

        if (!entry) {
            const built = await buildManifest(name, reference);
            entry = {
                name: built.name,
                reference: built.reference,
                manifestBytes: built.manifestBytes,
                manifestDigest: built.manifestDigest,
                mediaType: built.mediaType,
                blobPaths: built.blobPaths
            };
            memoPut(key, entry);
        }

        return entry;
    }

    /**
     * باز کردن استریم خام یک blob — هدرهای پاسخ فوراً به کلاینت می‌روند و
     * بایت‌ها بدون کپی از سرویس منبع استریم می‌شوند.
     *
     * نکته: درخواست blob فقط digest دارد؛ tag از حافظه‌ی isolate پیدا می‌شود
     * (docker قبل از blobها همیشه منیفست را درخواست می‌کند). اگر isolate
     * ری‌استارت شده باشد، 404 برمی‌گردد و pull دوباره از منیفست شروع می‌شود.
     *
     * @returns {Promise<{size:number, stream:ReadableStream}|null>}
     */
    async function openBlob(name, digest) {
        const reference = memoFindReferenceByBlob(name, digest);
        if (!reference) {
            return null;
        }

        const blobPath = `blobs/sha256/${digest.replace('sha256:', '')}`;
        const registries = getRegistries();
        const failures = [];

        for (const registry of registries) {
            const imageRef = `${registry}/${name}:${reference}`;
            try {
                const tarStream = await fetchTarball(imageRef);
                const member = await openTarMember(tarStream, blobPath);
                if (member) {
                    return member;
                }
                failures.push(`${registry}: بلاب ${digest} در tarball پیدا نشد`);
            } catch (err) {
                failures.push(`${registry}: ${err.message}`);
            }
        }

        throw new Error(`بلاب ${digest} قابل دریافت نبود:\n${failures.join('\n')}`);
    }

    return { resolveManifest, openBlob };
}

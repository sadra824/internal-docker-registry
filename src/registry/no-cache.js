/**
 * پیاده‌سازی «رجیستری بدون ذخیره‌سازی» برای بک‌اند serverless-registry.
 *
 * دو جزء دارد:
 *
 *  ۱) NoCacheRegistry — پیاده‌سازی اینترفیس Registry که:
 *     - همه‌ی خواندن‌ها را «miss» برمی‌گرداند تا روترِ serverless-registry
 *       سراغ fallback (رجیستری‌های بالادستی در REGISTRIES_JSON) برود و
 *       پاسخ را مستقیم به کلاینت استریم کند؛
 *     - همه‌ی نوشتن‌ها (putManifest/monolithicUpload که روتر بعد از fallback
 *       برای «ذخیره» صدا می‌زند) را no-op می‌کند — یعنی هیچ چیزی ذخیره
 *       نمی‌شود و کشی وجود ندارد.
 *
 *  ۲) emptyBucket — شکلِ یک R2 bucket خالی برای جاهایی که روتر مستقیماً
 *     env.REGISTRY را صدا می‌زند (HEAD blob ،فهرست تگ‌ها و …).
 *
 * نتیجه: رجیستریِ فقط-pull که هر درخواست را از upstream می‌گیرد و هیچ
 * داده‌ای نگه نمی‌دارد. push در سطح مسیر با 501 رد می‌شود؛ متدهای
 * نوشتنی این کلاس فقط لایه‌ی اطمینان‌اند.
 */

import { readOnlyUnsupported } from '../lib/http.js';
import { logger } from '../lib/log.js';

/** لاگ سطح debug برای دنبال‌کردن جریان (با env.LOG_LEVEL=debug فعال می‌شود) */
const log = logger('no-cache');

/** خطای اینترفیس Registry — همان قرارداد {response} روتر serverless-registry */
function registryError(status, code, message) {
    return {
        response: Response.json(
            { errors: [{ code, message }] },
            { status }
        )
    };
}

function manifestUnknown() {
    return registryError(404, 'MANIFEST_UNKNOWN', 'manifest unknown');
}

function blobUnknown() {
    return registryError(404, 'BLOB_UNKNOWN', 'blob unknown to registry');
}

function unsupported() {
    // readOnlyUnsupported() یک Response است؛ اینجا در قرارداد Registry می‌پیچیم
    const response = readOnlyUnsupported();
    return { response };
}

/** دور انداختن امن استریم (تا شاخه‌ی tee بلااستفاده بافر نگه ندارد) */
async function discardStream(stream) {
    try {
        await stream.cancel();
    } catch (_) {
        // best-effort
    }
}

export class NoCacheRegistry {
    // ---------- خواندن‌ها: همیشه miss (مسیر fallback روتر) ----------

    async manifestExists() {
        return { exists: false };
    }

    async getManifest() {
        return manifestUnknown();
    }

    async layerExists() {
        return { exists: false };
    }

    async getLayer() {
        return blobUnknown();
    }

    async listRepositories() {
        return { repositories: [] };
    }

    async listReferrers() {
        return { manifests: [] };
    }

    // ---------- نوشتن‌های داخلی روتر (بعد از fallback): no-op ----------

    async putManifest(namespace, reference, stream) {
        log.debug('putManifest discarded (no storage)', { repository: namespace, reference });
        await discardStream(stream);
        return {
            digest: `sha256:${'0'.repeat(64)}`,
            location: `/${namespace}/manifests/${reference}`
        };
    }

    async monolithicUpload(_namespace, digest, stream) {
        log.debug('monolithicUpload discarded (no storage)', { digest });
        await discardStream(stream);
        return { digest, location: '/' };
    }

    // ---------- push: بدون ذخیره ممکن نیست ----------

    async startUpload() {
        return unsupported();
    }

    async mountExistingLayer() {
        return unsupported();
    }

    async uploadChunk() {
        return unsupported();
    }

    async finishUpload() {
        return unsupported();
    }

    async cancelUpload() {
        return true;
    }

    async getUpload() {
        return registryError(404, 'BLOB_UPLOAD_UNKNOWN', 'upload unknown');
    }

    async garbageCollection() {
        return false;
    }
}

/** شبیه‌سازی R2Bucket خالی — چون روتر در چند مسیر مستقیماً env.REGISTRY را صدا می‌زند */
export const emptyBucket = {
    async head() {
        return null;
    },
    async get() {
        return null;
    },
    async list() {
        return { objects: [], truncated: false };
    },
    async put() {
        return undefined;
    },
    async delete() {
        return undefined;
    }
};

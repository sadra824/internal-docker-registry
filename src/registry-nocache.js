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
 *  ۲) EmptyBucket — شکلِ یک R2 bucket خالی برای جاهایی که روتر مستقیماً
 *     env.REGISTRY را صدا می‌زند (HEAD blob ،فهرست تگ‌ها و …).
 *
 * نتیجه: رجیستریِ فقط-pull که هر درخواست را از upstream می‌گیرد و هیچ
 * داده‌ای نگه نمی‌دارد. push هم در سطح روتر ما با 501 رد می‌شود.
 */

function errorResponse(status, code, message) {
    return {
        response: Response.json(
            { errors: [{ code, message }] },
            { status }
        )
    };
}

/** دور انداختن امن استریم (تا شاخه‌ی tee بلا use بافر نگه ندارد) */
async function discardStream(stream) {
    try {
        await stream.cancel();
    } catch (_) {
        // best-effort
    }
}

export class NoCacheRegistry {
    // ---------- خواندن‌ها: همیشه miss ----------

    async manifestExists() {
        return { exists: false };
    }

    async getManifest() {
        return errorResponse(404, 'MANIFEST_UNKNOWN', 'manifest unknown');
    }

    async layerExists() {
        return { exists: false };
    }

    async getLayer() {
        return errorResponse(404, 'BLOB_UNKNOWN', 'blob unknown to registry');
    }

    async listRepositories() {
        return { repositories: [] };
    }

    async listReferrers() {
        return { manifests: [] };
    }

    // ---------- نوشتن‌ها: no-op (ذخیره‌ای وجود ندارد) ----------

    async putManifest(namespace, reference, stream) {
        await discardStream(stream);
        return { digest: `sha256:${'0'.repeat(64)}`, location: `/${namespace}/manifests/${reference}` };
    }

    async monolithicUpload(_namespace, digest, stream) {
        await discardStream(stream);
        return { digest, location: '/' };
    }

    // ---------- push: بدون ذخیره ممکن نیست ----------
    // (این متدها در عمل توسط گیتِ فقط-خواندنیِ روترِ ما قبل از رسیدن به
    // این‌جا با 501 رد می‌شوند؛ این پیاده‌سازی فقط برای اطمینان است.)

    async startUpload() {
        return errorResponse(501, 'UNSUPPORTED', 'این رجیستری فقط از pull پشتیبانی می‌کند');
    }

    async mountExistingLayer() {
        return errorResponse(501, 'UNSUPPORTED', 'این رجیستری فقط از pull پشتیبانی می‌کند');
    }

    async uploadChunk() {
        return errorResponse(501, 'UNSUPPORTED', 'این رجیستری فقط از pull پشتیبانی می‌کند');
    }

    async finishUpload() {
        return errorResponse(501, 'UNSUPPORTED', 'این رجیستری فقط از pull پشتیبانی می‌کند');
    }

    async cancelUpload() {
        return true;
    }

    async getUpload() {
        return errorResponse(404, 'BLOB_UPLOAD_UNKNOWN', 'upload unknown');
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

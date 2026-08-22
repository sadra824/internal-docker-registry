/**
 * نقطه‌ی ورود Worker — فقط «جدول مسیرها» و سیم‌کشی وابستگی‌ها.
 *
 *  ۱) /v2/…        → routes/registry.js  (بک‌اند serverless-registry،
 *                    بدون ذخیره‌سازی، بدون احراز هویت، فقط pull)
 *  ۲) /image و /platforms → routes/passthrough.js (استریم مستقیم تاربال
 *                    از سرویس منبع — مناسب wget -c | docker load)
 *  ۳) بقیه          → لندینگ را Static Assets خود پلتفرم می‌دهد؛
 *                    هر چیز دیگر 404
 *
 * لاگ: هر درخواست (متد/مسیر/وضعیت/مدت) + سطح با env.LOG_LEVEL.
 * هیچ استثنایی از fetch بیرون نمی‌رود — آخرین شبکه‌ی ایمن 500 برمی‌گرداند.
 */

import v2Router from '../vendor/serverless-registry/src/router.ts';
import { InternalError } from '../vendor/serverless-registry/src/errors.ts';
import { createRegistryRoute } from './routes/registry.js';
import { createPassthroughRouter } from './routes/passthrough.js';
import { NoCacheRegistry, emptyBucket } from './registry/no-cache.js';
import { getRegistries } from './services/registries.js';
import { notFound, internalError } from './lib/http.js';
import { logger, setLogLevel } from './lib/log.js';

const PATHS = {
    registryApi: '/v2',
    image: '/image',
    platforms: '/platforms'
};

const log = logger('worker');

// stateless هستند؛ یک بار در سطح isolate ساخته می‌شوند
const registryRoute = createRegistryRoute({
    v2Router,
    registryClient: new NoCacheRegistry(),
    bucket: emptyBucket,
    InternalError
});

/** سیم‌کشی env → وابستگی‌های مسیر دانلود مستقیم */
function buildPassthroughRoute(env) {
    return createPassthroughRouter({
        getRegistries: () => getRegistries(env),
        sourceBaseUrl: env.SOURCE_BASE_URL,
        // فقط Range برای ادامه‌ی دانلود (wget -c) پاس داده می‌شود؛
        // بدون signal تا استریم‌های طولانی وسط راه قطع نشوند
        fetchRaw: (target, request) => {
            const range = request.headers.get('Range');
            return fetch(target, {
                redirect: 'follow',
                headers: range ? { Range: range } : undefined
            });
        }
    });
}

/** dispatch + لاگ هر درخواست (متد، مسیر، وضعیت، مدت) */
async function dispatch(request, env, ctx) {
    const startedAt = Date.now();
    const { pathname } = new URL(request.url);
    const described = `${request.method} ${pathname}`;

    let response;
    try {
        if (pathname === PATHS.registryApi || pathname.startsWith(`${PATHS.registryApi}/`)) {
            response = await registryRoute(request, env, ctx);
        } else if (pathname === PATHS.image || pathname === PATHS.platforms) {
            response = await buildPassthroughRoute(env)(request);
        } else {
            response = notFound();
        }
    } catch (err) {
        // خطای پیش‌بینی‌نشده — هیچ استثنایی نباید از fetch بیرون برود
        log.error('unhandled error', { request: described, error: err?.message });
        response = internalError();
    }

    log.info('request', {
        request: described,
        status: response.status,
        ms: Date.now() - startedAt
    });

    return response;
}

let configuredEnv = null;

export default {
    async fetch(request, env, ctx) {
        // تنظیم سطح لاگ یک بار به‌ازای هر env (env در طول عمر isolate ثابت است)
        if (configuredEnv !== env) {
            setLogLevel(env.LOG_LEVEL);
            configuredEnv = env;
        }

        try {
            return await dispatch(request, env, ctx);
        } catch (err) {
            // حتی اگر خود dispatch (مثلاً new URL) شکست بخورد
            log.error('dispatch failed', { error: err?.message });
            return internalError();
        }
    }
};

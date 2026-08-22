/**
 * نقطه‌ی ورود Worker — فقط «جدول مسیرها» و سیم‌کشی وابستگی‌ها.
 *
 *  ۱) /v2/…        → routes/registry.js  (بک‌اند serverless-registry،
 *                    بدون ذخیره‌سازی، بدون احراز هویت، فقط pull)
 *  ۲) /image و /platforms → routes/passthrough.js (استریم مستقیم تاربال
 *                    از سرویس منبع — مناسب wget -c | docker load)
 *  ۳) بقیه          → لندینگ را Static Assets خود پلتفرم می‌دهد؛
 *                    هر چیز دیگر 404
 */

import v2Router from '../vendor/serverless-registry/src/router.ts';
import { InternalError } from '../vendor/serverless-registry/src/errors.ts';
import { createRegistryRoute } from './routes/registry.js';
import { createPassthroughRouter } from './routes/passthrough.js';
import { NoCacheRegistry, emptyBucket } from './registry/no-cache.js';
import { getRegistries } from './services/registries.js';
import { notFound, internalError } from './lib/http.js';

const PATHS = {
    registryApi: '/v2',
    image: '/image',
    platforms: '/platforms'
};

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

export default {
    async fetch(request, env, ctx) {
        const { pathname } = new URL(request.url);

        if (pathname === PATHS.registryApi || pathname.startsWith(`${PATHS.registryApi}/`)) {
            return registryRoute(request, env, ctx);
        }

        if (pathname === PATHS.image || pathname === PATHS.platforms) {
            try {
                return await buildPassthroughRoute(env)(request);
            } catch (err) {
                console.error('passthrough error:', err);
                return internalError();
            }
        }

        return notFound();
    }
};

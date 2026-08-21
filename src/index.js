/**
 * نقطه‌ی ورود Cloudflare Worker.
 *
 * تفاوت‌ها با نسخه Node:
 *  - به‌جای app.listen فقط export fetch داریم (محیط request-driven است)
 *  - به‌جای process.env از env.X (Vars/Bindings ورکر) استفاده می‌شود
 *  - لندینگ پیج با Static Assets خود ورکر سرو می‌شود (نه express.static)
 *  - به‌جای setInterval، پاک‌سازی کش دائمی با Cron Trigger انجام می‌شود
 *  - کش به‌طور پیش‌فرض خاموش است:
 *      CACHE_ENABLED=false → استور موقتِ Cache API با TTL (پیش‌فرض ۳۰ دقیقه)
 *      CACHE_ENABLED=true  → استور دائمی R2 (نیازمند بایندینگ REGISTRY_BUCKET)
 */

import { createV2Router } from './routes/v2.js';
import { createPassthroughRouter } from './routes/passthrough.js';
import { TransientStore } from './storage/transient.js';
import { R2Store } from './storage/r2.js';
import { MemoryStore } from './storage/memory.js';
import { getRegistries } from './services/registries.js';
import { fetchTarball } from './services/fetcher.js';

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    return String(value).toLowerCase() === 'true';
}

function parseSize(value, defaultValue = 0) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value).trim().toUpperCase();
    const matchm = normalized.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/);
    if (!matchm) {
        throw new Error(
            `CACHE_MAX_SIZE نامعتبر است: "${value}". مثال معتبر: 500MB، 10GB، 1TB`
        );
    }

    const multipliers = {
        B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4
    };

    return Math.floor(Number(matchm[1]) * multipliers[matchm[2] || 'B']);
}

// روتر در سطح isolate ساخته می‌شود تا نقشه‌ی pending بین درخواست‌ها مشترک بماند
let cachedRouter = null;
let cachedRouterEnv = null;

function getRouter(env) {
    if (cachedRouter && cachedRouterEnv === env) {
        return cachedRouter;
    }

    const cacheEnabled = parseBoolean(env.CACHE_ENABLED, false);
    const ttlSeconds = Number(env.TRANSIENT_TTL_SECONDS || 1800);

    let store;
    if (cacheEnabled) {
        if (!env.REGISTRY_BUCKET) {
            throw new Error(
                'CACHE_ENABLED=true است ولی بایندینگ REGISTRY_BUCKET تنظیم نشده است. ' +
                'در wrangler.jsonc بخش r2_buckets را فعال کنید.'
            );
        }
        store = new R2Store(env.REGISTRY_BUCKET);
    } else if (typeof caches !== 'undefined' && caches.default) {
        store = new TransientStore(ttlSeconds);
    } else {
        // محیط بدون Cache API (مثلاً بعضی تست‌ها) — فقط درون isolate
        store = new MemoryStore();
    }

    cachedRouter = createV2Router({
        store,
        cacheEnabled,
        getRegistries: () => getRegistries(env),
        fetchTarball: (imageRef) => fetchTarball(imageRef, {
            sourceBaseUrl: env.SOURCE_BASE_URL,
            timeoutMs: Number(env.FETCH_TIMEOUT_MS || 60000)
        }),
        os: env.DEFAULT_PLATFORM_OS || 'linux',
        arch: env.DEFAULT_PLATFORM_ARCH || 'amd64'
    });

    cachedRouterEnv = env;
    return cachedRouter;
}

function notFound() {
    return Response.json(
        { errors: [{ code: 'NOT_FOUND', message: 'مسیر یافت نشد' }] },
        { status: 404 }
    );
}

// مسیر دانلود مستقیم — بدون state، ساختنش در هر درخواست ارزان است
function getPassthroughRouter(env) {
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
        void ctx;

        const url = new URL(request.url);

        // دانلود مستقیم (pass-through) — سبک‌ترین مسیر، مناسب پلن رایگان
        if (
            url.pathname === '/image'
            || url.pathname === '/platforms'
        ) {
            try {
                return await getPassthroughRouter(env)(request);
            } catch (err) {
                return Response.json(
                    { errors: [{ code: 'INTERNAL_ERROR', message: 'خطای داخلی سرور' }] },
                    { status: 500 }
                );
            }
        }

        if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
            let router;
            try {
                router = getRouter(env);
            } catch (err) {
                return Response.json(
                    { errors: [{ code: 'CONFIG_ERROR', message: err.message }] },
                    { status: 500 }
                );
            }

            try {
                const response = await router(request);
                return response || notFound();
            } catch (err) {
                return Response.json(
                    { errors: [{ code: 'INTERNAL_ERROR', message: 'خطای داخلی سرور' }] },
                    { status: 500 }
                );
            }
        }

        // بقیه‌ی مسیرها: فایل‌های استاتیک را خود پلتفرم می‌دهد؛
        // هر چیز دیگری 404 است.
        return notFound();
    },

    /**
     * Cron Trigger — جایگزین setInterval نسخه Node.
     * فقط در حالت کش دائمی (R2) و وقتی CACHE_MAX_SIZE > 0 است کاری می‌کند.
     */
    async scheduled(event, env, ctx) {
        void event;

        const cacheEnabled = parseBoolean(env.CACHE_ENABLED, false);
        const maxBytes = parseSize(env.CACHE_MAX_SIZE, 0);

        if (!cacheEnabled || !maxBytes || !env.REGISTRY_BUCKET) {
            return;
        }

        const store = new R2Store(env.REGISTRY_BUCKET);
        ctx.waitUntil(store.cleanup(maxBytes));
    }
};

/**
 * نقطه‌ی ورود Worker — حالت «استریم مستقیم»:
 *
 *  - بدون ذخیره‌سازی: هیچ داده‌ای روی Cache/R2/دیسک نوشته نمی‌شود
 *  - بدون پردازش سنگین: منیفست فقط از متادیتای کوچک tarball ساخته
 *    می‌شود و لایه‌ها بایت‌به‌بایت پاس داده می‌شوند (CPU ≈ صفر؛ مناسب
 *    حتی پلن رایگان با سقف ۱۰ms)
 *  - فقط متادیتای چند‌کیلوبایتی (tag → منیفست) تا ۱۰ دقیقه در حافظه‌ی
 *    isolate نگه داشته می‌شود تا درخواست‌های بعدی همان pull سریع باشند
 *  - پلتفرم (os/arch) به‌صورت پارامتر query به سرویس منبع پاس داده می‌شود
 */

import { createV2Router } from './routes/v2.js';
import { createPassthroughRouter } from './routes/passthrough.js';
import { getRegistries } from './services/registries.js';
import { fetchTarball } from './services/fetcher.js';

// روتر در سطح isolate ساخته می‌شود تا حافظه‌ی tag→منیفست بین درخواست‌ها مشترک بماند
let cachedRouter = null;
let cachedRouterEnv = null;

function getRouter(env) {
    if (cachedRouter && cachedRouterEnv === env) {
        return cachedRouter;
    }

    cachedRouter = createV2Router({
        getRegistries: () => getRegistries(env),
        fetchTarball: (imageRef) => fetchTarball(imageRef, {
            sourceBaseUrl: env.SOURCE_BASE_URL,
            timeoutMs: Number(env.FETCH_TIMEOUT_MS || 120000),
            os: env.DEFAULT_PLATFORM_OS,
            arch: env.DEFAULT_PLATFORM_ARCH,
            variant: env.DEFAULT_PLATFORM_VARIANT
        })
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

        // دانلود مستقیم تاربال (wget | docker load) — استریم خالص، CPU ≈ صفر
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
            try {
                const router = getRouter(env);
                const response = await router(request);
                return response || notFound();
            } catch (err) {
                return Response.json(
                    { errors: [{ code: 'INTERNAL_ERROR', message: 'خطای داخلی سرور' }] },
                    { status: 500 }
                );
            }
        }

        // بقیه‌ی مسیرها: فایل‌های استاتیک (لندینگ) را خود پلتفرم می‌دهد؛
        // هر چیز دیگری 404 است.
        return notFound();
    }
};

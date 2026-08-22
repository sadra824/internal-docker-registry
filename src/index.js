/**
 * نقطه‌ی ورود Worker — ترکیب سه بخش:
 *
 *  ۱) /v2/…  → بک‌اند رسمی serverless-registry کلاودفلر (vendor شده در
 *     vendor/serverless-registry — Apache-2.0):
 *       - رجیستری کامل OCI روی R2 (push و pull)
 *       - احراز هویت (USERNAME/PASSWORD یا JWT) — بدون credential پاسخ 401 می‌دهد
 *       - pull fallback: اگر ایمیج در R2 نباشد، از رجیستری‌های بالادستی
 *         (REGISTRIES_JSON) گرفته و در R2 ذخیره می‌شود؛ pullهای بعدی مستقیم از R2
 *
 *  ۲) /image و /platforms → دانلود مستقیم تاربال از سرویس منبع
 *     (استریم خالص، بدون ذخیره‌سازی — مناسب wget -c | docker load)
 *
 *  ۳) / → لندینگ پیج (Static Assets خود پلتفرم)
 */

import registryBackend from '../vendor/serverless-registry/index.ts';
import { createPassthroughRouter } from './routes/passthrough.js';
import { getRegistries } from './services/registries.js';

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
        const url = new URL(request.url);

        // بک‌اند رجیستری — همه‌ی مسیرهای /v2 را به serverless-registry می‌دهیم
        if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
            return registryBackend.fetch(request, env, ctx);
        }

        // دانلود مستقیم تاربال (wget | docker load) — استریم خالص
        if (url.pathname === '/image' || url.pathname === '/platforms') {
            try {
                return await getPassthroughRouter(env)(request);
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

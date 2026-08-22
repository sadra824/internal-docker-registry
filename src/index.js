/**
 * نقطه‌ی ورود Worker — ترکیب سه بخش:
 *
 *  ۱) /v2/…  → بک‌اند serverless-registry کلاودفلر (vendor شده، دست‌نخورده)
 *     در «حالت بدون ذخیره‌سازی»:
 *       - احراز هویت (USERNAME/PASSWORD یا JWT) — بدون credential پاسخ 401
 *       - هر pull از رجیستری‌های بالادستی (REGISTRIES_JSON) گرفته و
 *         مستقیم به کلاینت استریم می‌شود — هیچ داده‌ای در R2/کش ذخیره نمی‌شود
 *       - فقط pull؛ push (POST/PATCH/PUT/DELETE) با 501 رد می‌شود
 *
 *  ۲) /image و /platforms → دانلود مستقیم تاربال از سرویس منبع
 *     (استریم خالص، بدون ذخیره‌سازی — مناسب wget -c | docker load)
 *
 *  ۳) / → لندینگ پیج (Static Assets خود پلتفرم)
 */

import v2Router from '../vendor/serverless-registry/src/router.ts';
import { AuthErrorResponse, InternalError } from '../vendor/serverless-registry/src/errors.ts';
import { authenticationMethodFromEnv } from '../vendor/serverless-registry/src/authentication-method.ts';
import { NoCacheRegistry, emptyBucket } from './registry-nocache.js';
import { createPassthroughRouter } from './routes/passthrough.js';
import { getRegistries } from './services/registries.js';

function notFound() {
    return Response.json(
        { errors: [{ code: 'NOT_FOUND', message: 'مسیر یافت نشد' }] },
        { status: 404 }
    );
}

/** فقط pull — همه‌ی عملیات نوشتن با 501 رد می‌شود (ذخیره‌ای وجود ندارد) */
function readOnlyGate(method) {
    if (method === 'GET' || method === 'HEAD') {
        return null;
    }
    return Response.json(
        {
            errors: [{
                code: 'UNSUPPORTED',
                message: 'این رجیستری فقط از pull پشتیبانی می‌کند'
            }]
        },
        { status: 501 }
    );
}

/** هندلر /v2 — همان جریان index.ts پروژه‌ی بالادستی، ولی با رجیستری بدون ذخیره */
async function handleRegistry(request, env, ctx) {
    const gate = readOnlyGate(request.method);
    if (gate) {
        return gate;
    }

    // بدون credential، همه‌چیز 401 (مطابق رفتار serverless-registry)
    const authMethod = await authenticationMethodFromEnv(env);
    if (!authMethod) {
        return new AuthErrorResponse(request);
    }

    const credentials = await authMethod.checkCredentials(request);
    if (!credentials.verified) {
        console.warn(`Not Authorized. authmode=${authMethod.authmode}. verified=false`);
        return new AuthErrorResponse(request);
    }

    // قلب تغییر: به‌جای R2Registry، پیاده‌سازی بدون ذخیره + bucket خالی
    env.REGISTRY = emptyBucket;
    env.REGISTRY_CLIENT = new NoCacheRegistry();

    try {
        return await v2Router.fetch(request, env, ctx);
    } catch (err) {
        if (err instanceof Response) {
            console.warn(`${request.method} ${err.status} ${err.url}`);
            return err;
        }
        console.error('router error:', err);
        return new InternalError();
    }
}

// مسیر دانلود مستقیم — بدون state، ساختنش در هر درخواست ارزان است
function getPassthroughRouter(env) {
    return createPassthroughRouter({
        getRegistries: () => getRegistries(env),
        sourceBaseUrl: env.SOURCE_BASE_URL,
        // فقط Range برای ادامه‌ی دانلود (wget -c) پاس داده می‌شود
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

        if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
            return handleRegistry(request, env, ctx);
        }

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

        // بقیه‌ی مسیرها: فایل‌های استاتیک (لندینگ) را خود پلتفرم می‌دهد
        return notFound();
    }
};

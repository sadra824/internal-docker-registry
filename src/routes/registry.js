/**
 * مسیر /v2 — واگذاری به روتر serverless-registry در حالت بدون ذخیره‌سازی.
 *
 * مسئولیت‌ها (هر یک جدا):
 *  ۱) گیت فقط‌خواندنی: همه‌ی متدهای نوشتن قبل از رسیدن به روتر 501 می‌گیرند
 *  ۲) تزریق وابستگی‌ها به env: به‌جای R2Registry/بکت واقعی، NoCacheRegistry
 *     و emptyBucket — یعنی هیچ داده‌ای ذخیره نمی‌شود و همه‌ی خواندن‌ها به
 *     fallback بالادستی می‌روند
 *  ۳) نرمال‌سازی نام ریپازیتوری (nginx → library/nginx)
 *  ۴) ترجمه‌ی خطای روتر به پاسخ HTTP
 *
 * وابستگی‌ها از بیرون تزریق می‌شوند تا این ماژول بدون vendor هم تست‌پذیر باشد.
 */

import { requestWithLibraryPrefix } from '../lib/repository-name.js';
import { notFound, readOnlyUnsupported } from '../lib/http.js';

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * @param {object} deps
 * @param {object} deps.v2Router        روتر serverless-registry (fetch(request, env, ctx))
 * @param {object} deps.registryClient   پیاده‌سازی Registry بدون ذخیره
 * @param {object} deps.bucket           شکل R2Bucket خالی
 * @param {new () => Response} deps.InternalError  خطای 500 پروژه‌ی بالادستی
 */
export function createRegistryRoute({ v2Router, registryClient, bucket, InternalError }) {
    return async function registryRoute(request, env, ctx) {
        if (!READ_METHODS.has(request.method)) {
            return readOnlyUnsupported();
        }

        env.REGISTRY = bucket;
        env.REGISTRY_CLIENT = registryClient;

        try {
            const res = await v2Router.fetch(requestWithLibraryPrefix(request), env, ctx);
            return res instanceof Response ? res : notFound();
        } catch (err) {
            if (err instanceof Response) {
                console.warn(`${request.method} ${err.status} ${err.url}`);
                return err;
            }
            console.error('registry router error:', err);
            return new InternalError();
        }
    };
}

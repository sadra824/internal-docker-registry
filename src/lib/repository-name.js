/**
 * نرمال‌سازی نام ریپازیتوری — تابعی خالص (خالص بودن = تست‌پذیری).
 *
 * دقیقاً مثل کاری که خود docker برای Docker Hub می‌کند: نام‌های تک‌بخشی
 * (مثل nginx) به library/nginx تبدیل می‌شوند؛ چون رجیستری‌های Hub/Mirror
 * بدون پیشوند library ایمیج رسمی را پیدا نمی‌کنند.
 *
 * دست‌نخورده می‌ماند:
 *  - نام‌های چندبخشی (sadra824/img یا ghcr.io/owner/img)
 *  - مسیرهای رزروشده با _ (_catalog)
 *  - ریشه (/v2 و /v2/)
 */

const V2_REPOSITORY_PATH = /^(\/v2\/)([^/_][^/]*)((?:\/(?:manifests|blobs|tags)\/.+|\/tags\/list)?)$/;

/**
 * اگر pathname یک ریپازیتوری تک‌بخشی v2 باشد، نسخه‌ی دارای پیشوند library
 * را برمی‌گرداند؛ وگرنه همان pathname را بدون تغییر.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function withLibraryPrefix(pathname) {
    const match = pathname.match(V2_REPOSITORY_PATH);
    if (!match) {
        return pathname;
    }
    const [, prefix, name, rest] = match;
    return `${prefix}library/${name}${rest}`;
}

/**
 * نسخه‌ی سطح-Request: در صورت نیاز، درخواست را با pathname نرمال‌شده
 * بازمی‌سازد (متد/هدر/بدنه حفظ می‌شوند).
 *
 * @param {Request} request
 * @returns {Request}
 */
export function requestWithLibraryPrefix(request) {
    const url = new URL(request.url);
    const pathname = withLibraryPrefix(url.pathname);

    if (pathname === url.pathname) {
        return request;
    }

    url.pathname = pathname;
    return new Request(url.toString(), request);
}

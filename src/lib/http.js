/**
 * پاسخ‌های خطای استاندارد سرویس — همه به فرمت خطای Docker Registry
 * ({"errors":[{"code","message"}]}) تا کلاینت‌ها بتوانند بخوانند.
 */

export function httpError(status, code, message) {
    return Response.json(
        { errors: [{ code, message }] },
        { status }
    );
}

export function notFound() {
    return httpError(404, 'NOT_FOUND', 'مسیر یافت نشد');
}

/** فقط pull — این رجیستری هیچ داده‌ای ندارد که رویش نوشته شود */
export function readOnlyUnsupported() {
    return httpError(501, 'UNSUPPORTED', 'این رجیستری فقط از pull پشتیبانی می‌کند');
}

export function internalError() {
    return httpError(500, 'INTERNAL_ERROR', 'خطای داخلی سرور');
}

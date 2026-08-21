/**
 * مسیر دانلود مستقیم (pass-through) — بدون ذخیره‌سازی و بدون پردازش.
 *
 *   GET /image?name=<ref>[&os=linux&arch=amd64&variant=v7]
 *        تاربال ایمیج (خروجی docker save) مستقیماً از سرویس منبع به کلاینت
 *        استریم می‌شود؛ فقط هدرها رد و بدل می‌شوند. CPU تقریباً صفر.
 *
 *   GET /platforms?name=<ref>
 *        فهرست پلتفرم‌های موجود ایمیج (JSON کوچک).
 *
 * کاربرد سمت کلاینت (مطابق مستندات سرویس منبع):
 *   wget -q -O - "https://<host>/image?name=nginx:latest" | docker load
 *   wget -c --content-disposition "https://<host>/image?name=nginx:latest"  # با قابلیت ادامه
 *
 * fallback: مثل مسیر /v2، رجیستری‌ها به‌ترتیب لیست امتحان می‌شوند و اولین
 * پاسخ موفق برنده است. اگر نام ایمیج خودش با هاست رجیستری شروع شود
 * (مثل ghcr.io/owner/img:tag) فقط همان یک مقصد امتحان می‌شود.
 * توجه: اگر خطا وسط استریم رخ دهد دیگر نمی‌توان به رجیستری بعدی رفت
 * (هدرها ارسال شده‌اند)؛ در این حالت کلاینت (wget -c) خودش retry می‌کند.
 */

const FORWARDED_RESPONSE_HEADERS = [
    'Content-Type',
    'Content-Length',
    'Content-Disposition',
    'Content-Range',
    'Accept-Ranges',
    'ETag',
    'Last-Modified'
];

function looksLikeRegistryHost(ref) {
    // اول tag را جدا کن (بخش بعد از آخرین «:» که بعد از آخرین «/» است)
    const withoutTag = ref.replace(/:[^/]*$/, '');
    const first = withoutTag.split('/')[0];
    return first.includes('.') || first.includes(':') || first === 'localhost';
}

export function createPassthroughRouter({
    getRegistries,
    fetchRaw,
    sourceBaseUrl = 'https://dockerimagesave.akiel.dev/image'
}) {
    function buildTarget(kind, ref, platform) {
        const base = kind === 'platforms'
            ? new URL(sourceBaseUrl).origin + '/platforms'
            : sourceBaseUrl;

        const query = new URLSearchParams({ name: ref });
        for (const key of ['os', 'arch', 'variant']) {
            if (platform[key]) query.set(key, platform[key]);
        }

        return `${base}?${query.toString()}`;
    }

    return async function passthroughRouter(request) {
        const url = new URL(request.url);
        const name = (url.searchParams.get('name') || '').trim();

        if (!name) {
            return Response.json(
                {
                    errors: [{
                        code: 'BAD_REQUEST',
                        message: 'پارامتر name الزامی است — مثال: ?name=nginx:latest'
                    }]
                },
                { status: 400 }
            );
        }

        const kind = url.pathname.endsWith('/platforms') ? 'platforms' : 'image';

        const platform = {};
        for (const key of ['os', 'arch', 'variant']) {
            const value = url.searchParams.get(key);
            if (value) platform[key] = value;
        }

        // اگر کاربر خودش رجیستری را مشخص کرده، فقط همان‌جا
        const refs = kind === 'platforms' || looksLikeRegistryHost(name)
            ? [name]
            : getRegistries().map((registry) => `${registry}/${name}`);

        const failures = [];

        for (const ref of refs) {
            const target = buildTarget(kind, ref, platform);

            let upstream;
            try {
                upstream = await fetchRaw(target, request);
            } catch (err) {
                failures.push(`${ref}: ${err.message}`);
                continue;
            }

            if (!upstream.ok) {
                failures.push(`${ref}: HTTP ${upstream.status}`);
                continue;
            }

            // هدرهای مرتبط با دانلود را پاس بده — همین.
            const headers = {};
            for (const header of FORWARDED_RESPONSE_HEADERS) {
                const value = upstream.headers.get(header);
                if (value !== null) headers[header] = value;
            }
            if (!headers['Content-Type']) {
                headers['Content-Type'] = kind === 'platforms'
                    ? 'application/json'
                    : 'application/x-tar';
            }
            headers['Cache-Control'] = 'no-store';

            // بدنه بدون هیچ پردازشی استریم می‌شود (200 یا 206 برای resume)
            return new Response(upstream.body, {
                status: upstream.status,
                headers
            });
        }

        return Response.json(
            {
                errors: [{
                    code: 'UPSTREAM_UNAVAILABLE',
                    message: `ایمیج "${name}" از هیچ‌کدام از رجیستری‌های پیکربندی دریافت نشد:\n`
                        + failures.join('\n')
                }]
            },
            { status: 502 }
        );
    };
}

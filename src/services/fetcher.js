/**
 * دریافت tarball ایمیج از سرویس منبع — کاملاً استریمی، بدون fs.
 *
 * در Worker، fetch خودش redirect را دنبال می‌کند و اگر پاسخ
 * Content-Encoding داشته باشد خودش decompress می‌کند؛ اما اگر سرویس
 * منبع فایل .tar.gz خام بفرستد (بدون هدر)، با دیدن magic بایت‌های
 * gzip (1f 8b) آن را با DecompressionStream باز می‌کنیم — دقیقاً
 * مانند کاری که نسخه Node با zlib می‌کرد.
 */

// دانلود کامل یک tarball از سرویس منبع ممکن است برای ایمیج‌های بزرگ
// بیش از یک دقیقه طول بکشد؛ تایم‌اوت پیش‌فرض را ۲ دقیقه می‌گذاریم.
const DEFAULT_TIMEOUT_MS = 120000;

async function peekAndUnwrap(body) {
    const reader = body.getReader();
    const first = await reader.read();

    if (first.done) {
        return new ReadableStream({
            start(controller) {
                controller.close();
            }
        });
    }

    const isGzip = first.value.length >= 2
        && first.value[0] === 0x1f
        && first.value[1] === 0x8b;

    const source = new ReadableStream({
        start(controller) {
            controller.enqueue(first.value);
        },
        async pull(controller) {
            const chunk = await reader.read();
            if (chunk.done) {
                controller.close();
                return;
            }
            controller.enqueue(chunk.value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        }
    });

    return isGzip ? source.pipeThrough(new DecompressionStream('gzip')) : source;
}

/**
 * tarball ایمیج را به‌صورت استریم برمی‌گرداند.
 * @param {string} imageRef مثل "docker.io/library/nginx:latest"
 */
export async function fetchTarball(imageRef, options = {}) {
    const sourceBaseUrl = options.sourceBaseUrl
        || 'https://dockerimagesave.akiel.dev/image';
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    const url = `${sourceBaseUrl}?name=${encodeURIComponent(imageRef)}`;

    let res;
    try {
        res = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (err) {
        throw new Error(`دسترسی به سرویس منبع ممکن نشد: ${err.message}`);
    }

    if (!res.ok) {
        let body = '';
        try {
            body = await res.text();
        } catch (_) { /* بدنه خوانده نشد */ }
        throw new Error(
            `سرویس منبع تصویر خطای ${res.status} برگرداند: ${body.slice(0, 300)}`
        );
    }

    if (!res.body) {
        throw new Error('سرویس منبع تصویر بدنه‌ای برنگرداند');
    }

    return peekAndUnwrap(res.body);
}

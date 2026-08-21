/**
 * ابزارهای digest — مبتنی بر WebCrypto (قابل استفاده در Worker و Node 18+).
 * نکته: crypto.subtle.digest کل ورودی را یک‌جا می‌گیرد؛ فقط برای بافرهای
 * کوچک (منیفست/کانفیگ) استفاده شود، نه لایه‌های بزرگ.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export async function sha256Digest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < view.length; i += 1) {
        hex += HEX[view[i]];
    }
    return `sha256:${hex}`;
}

export function isValidDigest(value) {
    return /^sha256:[a-f0-9]{64}$/.test(value);
}

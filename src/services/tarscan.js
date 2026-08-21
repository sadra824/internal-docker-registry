/**
 * اسکنر سبکِ tar — مخصوص حالت «بدون ذخیره‌سازی و بدون پردازش».
 *
 * تفاوت اساسی با یک tar-parser معمولی:
 *  - داده‌ی اعضای بزرگ هرگز کپی یا بافر نمی‌شوند؛ برای رد کردن یک عضو
 *    فقط مرور می‌شوند (zero-copy drain) و CPU تقریباً هیچ مصرف نمی‌شود.
 *  - فقط هدرهای ۵۱۲ بایتی (نام + حجم) و اعضای JSON کوچک خوانده می‌شوند.
 *
 * چون digestها در فرمت OCI داخل مسیر اعضا هستند
 * (blobs/sha256/<hex>)، هیچ هش‌محاسبه‌ای لازم نیست.
 */

const BLOCK = 512;
const MAX_JSON_MEMBER = 8 * 1024 * 1024; // سقف اعضای JSON که بافر می‌شوند

const decoder = new TextDecoder();

function readString(bytes, offset, length) {
    let end = offset;
    const max = offset + length;
    while (end < max && bytes[end] !== 0) end += 1;
    return decoder.decode(bytes.subarray(offset, end));
}

function parseNumeric(bytes, offset, length) {
    if (bytes[offset] & 0x80) {
        let value = bytes[offset] & 0x7f;
        for (let i = 1; i < length; i += 1) value = value * 256 + bytes[offset + i];
        return value;
    }
    const raw = readString(bytes, offset, length).trim();
    return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function isAllZero(bytes) {
    for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] !== 0) return false;
    }
    return true;
}

export class TarScan {
    /**
     * @param {ReadableStream} stream استریم خام tar (در صورت لزوم gunzip شده)
     */
    constructor(stream) {
        this._reader = stream.getReader();
        this._pending = null; // باقی‌مانده‌ی chunk قبلی (view، بدون کپی)
        this._remaining = 0; // بایت‌های باقی‌مانده‌ی داده‌ی عضو جاری
        this._afterPad = 0; // padding بعد از عضو جاری
        this._done = false;
        this._longName = null;
    }

    /** یک chunk از استریم (یا از pending) — بدون ادغام و کپی */
    async _take() {
        if (this._pending && this._pending.length > 0) {
            const chunk = this._pending;
            this._pending = null;
            return chunk;
        }
        if (this._done) return null;
        const result = await this._reader.read();
        if (result.done) {
            this._done = true;
            return null;
        }
        return result.value;
    }

    /** دقیقاً n بایت پیوسته (فقط برای هدرها — n کوچک است) */
    async _readExactly(n) {
        const out = new Uint8Array(n);
        let filled = 0;
        while (filled < n) {
            const chunk = await this._take();
            if (!chunk) return filled === n ? out : null;
            const need = n - filled;
            const use = Math.min(need, chunk.length);
            out.set(chunk.subarray(0, use), filled);
            filled += use;
            if (use < chunk.length) {
                this._pending = chunk.subarray(use);
            }
        }
        return out;
    }

    /** رد کردن داده‌ی عضو جاری + padding — بدون کپی */
    async skip() {
        let toSkip = this._remaining + this._afterPad;
        this._remaining = 0;
        this._afterPad = 0;

        if (this._pending) {
            const use = Math.min(toSkip, this._pending.length);
            this._pending = use < this._pending.length
                ? this._pending.subarray(use)
                : null;
            toSkip -= use;
        }

        while (toSkip > 0) {
            const chunk = await this._take();
            if (!chunk) return; // stream تمام شد
            if (chunk.length > toSkip) {
                this._pending = chunk.subarray(toSkip);
                return;
            }
            toSkip -= chunk.length;
        }
    }

    /** عضو بعدی — یا null در پایان archive */
    async next() {
        const header = await this._readExactly(BLOCK);
        if (!header) return null;
        if (isAllZero(header)) return null; // دو بلاک صفر = پایان

        const rawName = readString(header, 0, 100);
        const size = parseNumeric(header, 124, 12);
        const typeCode = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const prefix = readString(header, 345, 155);
        const magic = readString(header, 257, 6);

        let name = magic.startsWith('ustar') && prefix
            ? `${prefix}/${rawName}`
            : rawName;

        this._remaining = size;
        this._afterPad = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);

        // GNU long name
        if (typeCode === 'L') {
            this._longName = decoder.decode(await this.readSmall()).replace(/\0+$/, '');
            await this.skip(); // padding عضو L
            return this.next();
        }
        if (this._longName) {
            name = this._longName;
            this._longName = null;
        }

        return { name, size, typeflag: typeCode };
    }

    /** کل داده‌ی عضو جاری (فقط برای JSONهای کوچک) */
    async readSmall(cap = MAX_JSON_MEMBER) {
        const limit = Math.min(this._remaining, cap);
        const out = new Uint8Array(limit);
        let filled = 0;
        while (filled < limit) {
            const chunk = await this._take();
            if (!chunk) break;
            const use = Math.min(limit - filled, chunk.length);
            out.set(chunk.subarray(0, use), filled);
            filled += use;
            if (use < chunk.length) this._pending = chunk.subarray(use);
        }
        this._remaining -= filled;
        return out.subarray(0, filled);
    }

    /**
     * استریمِ پاس‌داده‌ی عضو جاری — داده‌ها همان‌طور که می‌رسند به مصرف‌کننده
     * می‌روند، بدون کپی. بعد از پایان عضو، استریم بسته می‌شود.
     */
    passthrough() {
        const self = this;
        return new ReadableStream({
            async pull(controller) {
                let left = self._remaining;
                if (left <= 0) {
                    controller.close();
                    return;
                }
                const chunk = await self._take();
                if (!chunk || chunk.length === 0) {
                    controller.close();
                    return;
                }
                const use = Math.min(left, chunk.length);
                self._remaining -= use;
                if (use < chunk.length) {
                    self._pending = chunk.subarray(use);
                }
                if (use === left) {
                    controller.enqueue(chunk.subarray(0, use));
                    controller.close();
                } else {
                    controller.enqueue(chunk.subarray(0, use));
                }
            },
            cancel() {
                self.cancel();
            }
        });
    }

    async cancel() {
        this._done = true;
        this._pending = null;
        try {
            await this._reader.cancel();
        } catch (_) { /* best-effort */ }
    }
}

/**
 * متادیتای ایمیج را از tarball می‌خواند — فقط JSONهای کوچک بافر می‌شوند و
 * بقیه‌ی اعضا صرفاً مرور (skip) می‌شوند. به‌محض کامل شدن اطلاعات، خواندن
 * متوقف می‌شود.
 *
 * @returns {Promise<{
 *   manifestJson: Uint8Array|null,
 *   indexJson: Uint8Array|null,
 *   sizes: Map<string, number>
 * }>}
 */
export async function collectImageMeta(stream) {
    const scan = new TarScan(stream);
    const sizes = new Map();
    let manifestJson = null;
    let indexJson = null;

    try {
        for (;;) {
            const entry = await scan.next();
            if (!entry) break;

            if (entry.typeflag !== '0') {
                await scan.skip();
                sizes.set(entry.name, entry.size);
                continue;
            }

            sizes.set(entry.name, entry.size);

            if (entry.name === 'manifest.json' && entry.size <= MAX_JSON_MEMBER) {
                manifestJson = await scan.readSmall();
                await scan.skip();
            } else if (entry.name === 'index.json' && entry.size <= MAX_JSON_MEMBER) {
                indexJson = await scan.readSmall();
                await scan.skip();
            } else {
                await scan.skip();
            }

            // خروج زودهنگام: همه‌ی مسیرهای ارجاع‌شده دیده شده‌اند
            if (manifestJson) {
                try {
                    const entry0 = JSON.parse(decoder.decode(manifestJson))[0];
                    if (entry0 && sizes.has(entry0.Config)
                        && (entry0.Layers || []).every((p) => sizes.has(p))) {
                        break;
                    }
                } catch (_) { /* هنوز ناقص است — ادامه بده */ }
            }
        }
    } finally {
        await scan.cancel();
    }

    return { manifestJson, indexJson, sizes };
}

/**
 * عضو مشخصی از tarball را پیدا کرده و استریم خامِ آن را برمی‌گرداند
 * (بدون هیچ کپی یا پردازشی از بایت‌های داده).
 *
 * @returns {Promise<{size:number, stream:ReadableStream}|null>}
 */
export async function openTarMember(stream, wantedPath) {
    const scan = new TarScan(stream);

    for (;;) {
        const entry = await scan.next();
        if (!entry) {
            await scan.cancel();
            return null;
        }

        if (entry.name === wantedPath && entry.typeflag === '0') {
            return {
                size: entry.size,
                stream: scan.passthrough()
            };
        }

        await scan.skip();
    }
}

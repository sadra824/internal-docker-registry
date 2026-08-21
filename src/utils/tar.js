/**
 * پارسر استریمی tar — بدون وابستگی و بدون filesystem.
 * فرمت tar ساده است: هدر ۵۱۲ بایتی + داده + padding تا مضرب ۵۱۲.
 *
 * چون archive فقط forward-readable است، در هر لحظه فقط یک entry
 * قابل خواندن است: بعد از next() باید entry را کامل خواند (یا skip کرد).
 */

const BLOCK = 512;
const DEFAULT_CHUNK_BYTES = 1024 * 1024; // 1MB

function readString(bytes, offset, length) {
    let end = offset;
    const max = offset + length;
    while (end < max && bytes[end] !== 0) end += 1;
    return new TextDecoder('utf-8').decode(bytes.subarray(offset, end));
}

/** اندازه فیلد عددی octal — با پشتیبانی از فرمت base-256 (فایل‌های > 8GB) */
function parseNumeric(bytes, offset, length) {
    // base-256: بایت اول 0x80 است
    if (bytes[offset] & 0x80) {
        let value = bytes[offset] & 0x7f;
        for (let i = 1; i < length; i += 1) {
            value = value * 256 + bytes[offset + i];
        }
        return value;
    }

    const raw = readString(bytes, offset, length).trim();
    if (raw === '') return 0;
    return Number.parseInt(raw, 8);
}

function isAllZero(bytes) {
    for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] !== 0) return false;
    }
    return true;
}

export class TarReader {
    /**
     * @param {ReadableStream} stream استریم خام (در صورت نیاز gzip از بیرون باز شده باشد)
     */
    constructor(stream) {
        this._reader = stream.getReader();
        this._buf = new Uint8Array(0);
        this._done = false;

        // وضعیت entry جاری
        this._remaining = 0; // بایت‌های باقی‌مانده‌ی داده‌ی entry فعلی
        this._afterPad = 0; // padding بعد از داده‌ی entry فعلی
        this._pendingLongName = null; // GNU long name (typeflag 'L')
    }

    async _fill(minBytes) {
        while (this._buf.length < minBytes && !this._done) {
            const result = await this._reader.read();
            if (result.done) {
                this._done = true;
                break;
            }
            const chunk = result.value;
            const merged = new Uint8Array(this._buf.length + chunk.length);
            merged.set(this._buf, 0);
            merged.set(chunk, this._buf.length);
            this._buf = merged;
        }
        return this._buf.length >= minBytes;
    }

    /** ورودی بعدی — یا null در پایان archive */
    async next() {
        //	entry قبلی کامل خوانده نشده باشد: صرف‌نظرش می‌کنیم
        await this._skipEntryData();

        if (!(await this._fill(BLOCK))) {
            return null; // EOF تمیز
        }

        const header = this._buf.subarray(0, BLOCK);

        // دو بلاک صفر = پایان archive
        if (isAllZero(header)) {
            this._buf = this._buf.subarray(BLOCK);
            return null;
        }

        const rawName = readString(header, 0, 100);
        const size = parseNumeric(header, 124, 12);
        const typeCode = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        const prefix = readString(header, 345, 155);
        const magic = readString(header, 257, 6);

        let name = magic.startsWith('ustar') && prefix
            ? `${prefix}/${rawName}`
            : rawName;

        this._buf = this._buf.subarray(BLOCK);

        // GNU long name: داده‌ی این entry نامِ واقعی entry بعدی است
        if (typeCode === 'L') {
            this._pendingLongName = new TextDecoder('utf-8')
                .decode(await this._readAllEntry())
                .replace(/\0+$/, '');
            return this.next();
        }

        if (this._pendingLongName) {
            name = this._pendingLongName;
            this._pendingLongName = null;
        }

        this._remaining = size;
        this._afterPad = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);

        return { name, size, typeflag: typeCode };
    }

    /** حداکثر maxBytes از داده‌ی entry جاری */
    async readChunk(maxBytes = DEFAULT_CHUNK_BYTES) {
        if (this._remaining === 0) return null;

        const want = Math.min(maxBytes, this._remaining);
        if (!(await this._fill(Math.min(want, BLOCK * 2))) && this._buf.length === 0) {
            // stream قبل از موعد تمام شد
            this._remaining = 0;
            this._afterPad = 0;
            return null;
        }

        const take = Math.min(want, this._buf.length);
        if (take === 0) {
            this._remaining = 0;
            this._afterPad = 0;
            return null;
        }

        const chunk = this._buf.subarray(0, take);
        this._buf = this._buf.subarray(take);
        this._remaining -= take;
        return chunk;
    }

    async _skipEntryData() {
        // داده‌ی باقی‌مانده‌ی entry فعلی را دور بریز
        while (this._remaining > 0) {
            if (this._buf.length === 0 && !(await this._fill(BLOCK))) {
                this._remaining = 0;
                this._afterPad = 0;
                return;
            }
            const take = Math.min(this._remaining, this._buf.length);
            this._buf = this._buf.subarray(take);
            this._remaining -= take;
        }

        // padding تا مضرب ۵۱۲
        while (this._afterPad > 0) {
            if (this._buf.length === 0 && !(await this._fill(Math.min(this._afterPad, BLOCK)))) {
                this._afterPad = 0;
                return;
            }
            const take = Math.min(this._afterPad, this._buf.length);
            this._buf = this._buf.subarray(take);
            this._afterPad -= take;
        }
    }

    /** کل داده‌ی entry جاری (فقط برای اعضای کوچک مثل JSON) */
    async _readAllEntry() {
        const parts = [];
        let total = 0;
        for (;;) {
            const chunk = await this.readChunk(DEFAULT_CHUNK_BYTES);
            if (!chunk) break;
            parts.push(chunk);
            total += chunk.length;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }

    readAll() {
        return this._readAllEntry();
    }

    /**
     * داده‌ی entry جاری به‌صورت ReadableStream (برای استریم کردن blobهای بزرگ).
     * توجه: تا پایان مصرف این استریم، next() صدا زده نشود.
     */
    entryStream(chunkBytes = DEFAULT_CHUNK_BYTES) {
        return new ReadableStream({
            pull: async (controller) => {
                const chunk = await this.readChunk(chunkBytes);
                if (!chunk || chunk.length === 0) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
            }
        });
    }
}

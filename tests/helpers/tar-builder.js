/**
 * سازنده‌ی tar برای تست‌ها — فرمت ustar مینیمال و معتبر.
 */

const encoder = new TextEncoder();

function encodeString(value, length) {
    const bytes = new Uint8Array(length);
    const src = encoder.encode(value);
    bytes.set(src.subarray(0, Math.min(length, src.length)));
    return bytes;
}

function tarHeader(name, size) {
    const buf = new Uint8Array(512);

    buf.set(encodeString(name, 100), 0);
    buf.set(encodeString('0000644\0', 8), 100); // mode
    buf.set(encodeString('0000000\0', 8), 108); // uid
    buf.set(encodeString('0000000\0', 8), 116); // gid
    buf.set(encodeString(size.toString(8).padStart(11, '0') + '\0', 12), 124); // size
    buf.set(encodeString('00000000000\0', 12), 136); // mtime

    // checksum موقت: فیلد checksum پر از فاصله باشد
    buf.set(encodeString('        ', 8), 148);

    buf[156] = 0x30; // typeflag '0' = regular file
    buf.set(encodeString('ustar\0', 6), 257); // magic
    buf.set(encodeString('00', 2), 263); // version

    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += buf[i];
    buf.set(encodeString(sum.toString(8).padStart(6, '0') + '\0 ', 8), 148);

    return buf;
}

export function tarMember(name, data) {
    const bytes = data instanceof Uint8Array ? data : encoder.encode(data);
    const header = tarHeader(name, bytes.length);
    const padLen = (512 - (bytes.length % 512)) % 512;

    const out = new Uint8Array(512 + bytes.length + padLen);
    out.set(header, 0);
    out.set(bytes, 512);
    return out;
}

export function tarStream(members) {
    const blocks = members.map((m) => tarMember(m.name, m.data));
    blocks.push(new Uint8Array(1024)); // دو بلاک صفر = پایان archive

    const total = blocks.reduce((sum, b) => sum + b.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const block of blocks) {
        out.set(block, offset);
        offset += block.length;
    }

    return new Response(out).body;
}

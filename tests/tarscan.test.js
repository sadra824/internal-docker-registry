/**
 * تست اسکنر استریمی tar — مخصوصاً مرز چانک‌ها (هدرها بین دو چانک)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImageMeta, openTarMember } from '../src/services/tarscan.js';
import { tarMember } from './helpers/tar-builder.js';

const encoder = new TextEncoder();

/** استریم با چانک‌های خیلی کوچک — تا منطق مرزها واقعاً تست شود */
function chunkedStream(bytes, chunkSize) {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) {
                controller.close();
                return;
            }
            const end = Math.min(offset + chunkSize, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
        }
    });
}

function concat(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function buildArchive(members) {
    const blocks = members.map((m) => tarMember(m.name, m.data));
    blocks.push(new Uint8Array(1024));
    return concat(blocks);
}

test('collectImageMeta: متادیتا و حجم اعضا (چانک ۷ بایتی — سخت‌ترین حالت)', async () => {
    const config = encoder.encode('{"os":"linux"}');
    const layer = encoder.encode('l'.repeat(1000));
    const configHex = 'a'.repeat(64);
    const layerHex = 'b'.repeat(64);
    const manifestJson = encoder.encode(JSON.stringify([{
        Config: `blobs/sha256/${configHex}`,
        RepoTags: ['x:y'],
        Layers: [`blobs/sha256/${layerHex}`]
    }]));

    const archive = buildArchive([
        { name: 'manifest.json', data: manifestJson },
        { name: `blobs/sha256/${configHex}`, data: config },
        { name: `blobs/sha256/${layerHex}`, data: layer }
    ]);

    const meta = await collectImageMeta(chunkedStream(archive, 7));

    assert.ok(meta.manifestJson);
    const parsed = JSON.parse(new TextDecoder().decode(meta.manifestJson));
    assert.equal(parsed[0].Config, `blobs/sha256/${configHex}`);
    assert.equal(meta.sizes.get(`blobs/sha256/${configHex}`), config.length);
    assert.equal(meta.sizes.get(`blobs/sha256/${layerHex}`), layer.length);
});

test('openTarMember: بایت‌های دقیق عضو، بدون تغییر', async () => {
    const wanted = encoder.encode(JSON.stringify({ hello: 'world' }));
    const filler = encoder.encode('x'.repeat(5000));
    const hexWanted = 'c'.repeat(64);
    const hexFiller = 'd'.repeat(64);

    const archive = buildArchive([
        { name: 'manifest.json', data: encoder.encode('[]') },
        { name: `blobs/sha256/${hexFiller}`, data: filler },
        { name: `blobs/sha256/${hexWanted}`, data: wanted },
        { name: `blobs/sha256/${'e'.repeat(64)}`, data: encoder.encode('tail') }
    ]);

    const member = await openTarMember(
        chunkedStream(archive, 13),
        `blobs/sha256/${hexWanted}`
    );

    assert.ok(member);
    assert.equal(member.size, wanted.length);
    const received = new Uint8Array(await new Response(member.stream).arrayBuffer());
    assert.deepEqual(received, wanted);
});

test('openTarMember: عضو ناموجود → null', async () => {
    const archive = buildArchive([
        { name: 'a.txt', data: encoder.encode('hi') }
    ]);
    const member = await openTarMember(chunkedStream(archive, 100), 'missing.bin');
    assert.equal(member, null);
});

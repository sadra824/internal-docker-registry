'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const tar = require('tar');

const SOURCE_BASE = process.env.SOURCE_BASE_URL || 'https://dockerimagesave.akiel.dev/image';
const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);

function get(url, redirectsLeft = 5, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, (res) => {
            const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);
            if (isRedirect && res.headers.location && redirectsLeft > 0) {
                res.resume();
                const nextUrl = new URL(res.headers.location, url).toString();
                resolve(get(nextUrl, redirectsLeft - 1, timeoutMs));
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`تایم‌اوت بعد از ${timeoutMs}ms`));
        });
    });
}

async function download(url, destFile, timeoutMs) {
    const res = await get(url, 5, timeoutMs);

    if (res.statusCode !== 200) {
        let body = '';
        for await (const chunk of res) body += chunk;
        throw new Error(
            `سرویس منبع تصویر خطای ${res.statusCode} برگرداند: ${body.slice(0, 300)}`
        );
    }

    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destFile);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
        res.on('error', reject);
    });
}

/**
 * ایمیج رو با همون الگوی wget از akiel.dev می‌گیره و در workDir استخراج می‌کنه.
 * imageRef باید به شکل "<image-registry>/<image-repository>/<image-name>:tag" باشه.
 */
async function fetchAndExtract(imageRef, workDir, timeoutMs) {
    const tarPath = path.join(workDir, 'image.tar');
    const url = `${SOURCE_BASE}?name=${encodeURIComponent(imageRef)}`;

    await download(url, tarPath, timeoutMs);

    const fd = fs.openSync(tarPath, 'r');
    const magic = Buffer.alloc(2);
    fs.readSync(fd, magic, 0, 2, 0);
    fs.closeSync(fd);
    const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;

    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    await new Promise((resolve, reject) => {
        const src = fs.createReadStream(tarPath);
        const input = isGzip ? src.pipe(zlib.createGunzip()) : src;
        input
            .pipe(tar.extract({ cwd: extractDir }))
            .on('finish', resolve)
            .on('error', reject);
        src.on('error', reject);
    });

    fs.unlinkSync(tarPath);
    return extractDir;
}

module.exports = { fetchAndExtract };
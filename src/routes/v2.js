/**
 * Docker Registry API v2 — کاملاً استریمی، بدون ذخیره‌سازی.
 * یک تابع خالص: (request) => Promise<Response | null>
 * null یعنی «این مسیر مال من نیست» (برای 404 سطح بالا).
 *
 * نکته‌ی مهم برای سرعت: پاسخ blob قبل از رسیدن داده‌ی سرویس منبع شروع
 * می‌شود (هدرها فوراً می‌روند و بدنه استریم می‌شود) — یعنی تایم‌اوتِ
 * «awaiting response headers» کلاینت داکر هرگز فعال نمی‌شود.
 */

import { createRegistryService } from '../services/registry.js';
import { sha256Digest } from '../utils/sha256.js';

const V2_API_HEADER = { 'Docker-Distribution-Api-Version': 'registry/2.0' };

function jsonError(status, code, message) {
    return Response.json(
        { errors: [{ code, message }] },
        { status, headers: V2_API_HEADER }
    );
}

export function createV2Router(deps) {
    const registry = createRegistryService({
        getRegistries: deps.getRegistries,
        fetchTarball: deps.fetchTarball
    });

    async function handleManifest(req, pathname, method) {
        const match = pathname.match(/^(.+)\/manifests\/([^/]+)$/);
        if (!match) return null;

        const name = decodeURIComponent(match[1].replace(/^\//, ''));
        const reference = decodeURIComponent(match[2]);

        try {
            const entry = await registry.resolveManifest(name, reference);
            const digest = entry.manifestDigest;

            const headers = {
                'Content-Type': entry.mediaType,
                'Docker-Content-Digest': digest,
                ...V2_API_HEADER
            };

            if (method === 'HEAD') {
                return new Response(null, {
                    status: 200,
                    headers: {
                        ...headers,
                        'Content-Length': String(entry.manifestBytes.length)
                    }
                });
            }

            return new Response(entry.manifestBytes, { status: 200, headers });
        } catch (err) {
            return jsonError(404, 'MANIFEST_UNKNOWN', err.message);
        }
    }

    async function handleBlob(req, pathname, method) {
        const match = pathname.match(/^(.+)\/blobs\/(sha256:[a-f0-9]{64})$/);
        if (!match) return null;

        const name = decodeURIComponent(match[1].replace(/^\//, ''));
        const digest = match[2];

        try {
            const blob = await registry.openBlob(name, digest);

            if (!blob) {
                return jsonError(404, 'BLOB_UNKNOWN', digest);
            }

            const headers = {
                'Content-Type': 'application/octet-stream',
                'Docker-Content-Digest': digest,
                'Content-Length': String(blob.size),
                ...V2_API_HEADER
            };

            // هدرها فوراً می‌روند؛ بدنه همان‌طور که از سرویس منبع
            // می‌رسد استریم می‌شود — بدون ذخیره و بدون پردازش.
            return new Response(blob.stream, { status: 200, headers });
        } catch (err) {
            return jsonError(404, 'BLOB_UNKNOWN', err.message);
        }
    }

    async function headBlob(req, pathname) {
        const match = pathname.match(/^(.+)\/blobs\/(sha256:[a-f0-9]{64})$/);
        if (!match) return null;

        const name = decodeURIComponent(match[1].replace(/^\//, ''));
        const digest = match[2];

        // برای حجم بلاب فقط باید هدرِ عضو tar پیدا شود — داده خوانده نمی‌شود
        try {
            const blob = await registry.openBlob(name, digest);
            if (!blob) {
                return jsonError(404, 'BLOB_UNKNOWN', digest);
            }
            blob.stream.cancel();

            return new Response(null, {
                status: 200,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Docker-Content-Digest': digest,
                    'Content-Length': String(blob.size),
                    ...V2_API_HEADER
                }
            });
        } catch (err) {
            return jsonError(404, 'BLOB_UNKNOWN', err.message);
        }
    }

    return async function v2Router(request) {
        const url = new URL(request.url);
        const pathname = decodeURIComponent(url.pathname.replace(/^\/v2/, '')) || '/';
        const method = request.method.toUpperCase();

        if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
            return Response.json({}, { headers: V2_API_HEADER });
        }

        if (pathname === '/healthz' && method === 'GET') {
            return new Response('ok', { headers: V2_API_HEADER });
        }

        // Push پشتیبانی نمی‌شود — این رجیستری فقط pull دارد
        if (/^\/.+\/blobs\/uploads\/?$/.test(pathname) && method === 'POST') {
            return jsonError(
                501,
                'UNSUPPORTED',
                'این رجیستری فقط از pull پشتیبانی می‌کند'
            );
        }

        // بدون ذخیره‌سازی، فهرست تگ دائمی نداریم
        if (pathname.endsWith('/tags/list') && method === 'GET') {
            const name = pathname.slice(0, -'/tags/list'.length).replace(/^\//, '');
            return Response.json({ name, tags: [] }, { headers: V2_API_HEADER });
        }

        if (method === 'HEAD' && /\/blobs\/sha256:/.test(pathname)) {
            const headRes = await headBlob(request, pathname);
            if (headRes) return headRes;
        }

        if (method === 'GET' || method === 'HEAD') {
            const manifestRes = await handleManifest(request, pathname, method);
            if (manifestRes) return manifestRes;

            const blobRes = await handleBlob(request, pathname, method);
            if (blobRes) return blobRes;
        }

        return null;
    };
}

/**
 * Docker Registry API v2 — روتر مستقل از runtime.
 * یک تابع خالص: (request) => Promise<Response | null>
 * null یعنی «این مسیر مال من نیست» (برای 404 سطح بالا).
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
    const { store, cacheEnabled } = deps;

    const registry = createRegistryService({
        store,
        getRegistries: deps.getRegistries,
        fetchTarball: deps.fetchTarball,
        os: deps.os,
        arch: deps.arch
    });

    async function handleManifest(req, pathname, method) {
        const match = pathname.match(/^(.+)\/manifests\/([^/]+)$/);
        if (!match) return null;

        const name = decodeURIComponent(match[1].replace(/^\//, ''));
        const reference = decodeURIComponent(match[2]);

        try {
            const { bytes, mediaType } = await registry.resolveManifest(name, reference);
            const digest = await sha256Digest(bytes);

            const headers = {
                'Content-Type': mediaType,
                'Docker-Content-Digest': digest,
                ...V2_API_HEADER
            };

            if (method === 'HEAD') {
                return new Response(null, {
                    status: 200,
                    headers: { ...headers, 'Content-Length': String(bytes.length) }
                });
            }

            return new Response(bytes, { status: 200, headers });
        } catch (err) {
            return jsonError(404, 'MANIFEST_UNKNOWN', err.message);
        }
    }

    async function handleBlob(req, pathname, method) {
        const match = pathname.match(/^(.+)\/blobs\/(sha256:[a-f0-9]{64})$/);
        if (!match) return null;

        const digest = match[2];
        const blob = await store.getBlob(digest);

        if (!blob) {
            return jsonError(404, 'BLOB_UNKNOWN', digest);
        }

        const headers = {
            'Content-Type': 'application/octet-stream',
            'Docker-Content-Digest': digest,
            ...V2_API_HEADER
        };

        if (method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: { ...headers, 'Content-Length': String(blob.size) }
            });
        }

        return new Response(blob.stream, { status: 200, headers });
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

        if (pathname.endsWith('/tags/list') && method === 'GET') {
            const name = pathname.slice(0, -'/tags/list'.length).replace(/^\//, '');
            const tags = cacheEnabled
                ? await store.listTags(name)
                : []; // در حالت بدون کش دائمی، فهرست تگ دائمی نداریم
            return Response.json({ name, tags }, { headers: V2_API_HEADER });
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

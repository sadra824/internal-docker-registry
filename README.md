# Sadhanet Docker Registry — on Cloudflare Workers

A lightweight, caching proxy for the Docker Registry API v2 that runs on **Cloudflare Workers**. It sits between your Docker client and upstream registries, fetches images through a configurable source service, converts them on the fly, and serves subsequent requests from the edge cache — or from **R2** when durable caching is enabled.

> **Caching is disabled by default.** With `CACHE_ENABLED=false` (the default), the proxy uses only a best-effort, short-lived edge cache (Cache API, 30-minute TTL). Set `CACHE_ENABLED=true` to persist blobs and manifests in an R2 bucket.

---

## ✨ Features

- **Docker Registry API v2 compliant** – Works seamlessly with `docker pull`, `docker build`, Kubernetes, and other container tools.
- **Runs on Cloudflare Workers** – No permanent server, no infrastructure to manage; every request executes at the edge. No `fs`, no `listen`, no `setInterval`.
- **Cache disabled by default** – Best-effort transient edge cache (Cache API) with a configurable TTL; opt in to durable caching backed by **R2** (S3-compatible).
- **Multi‑registry fallback** – Tries a prioritized list of upstream registries (`docker.arvancloud.ir`, `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `mcr.microsoft.com`, …) in parallel until the image is found.
- **Multi‑architecture support** – Automatically selects the appropriate platform variant based on `DEFAULT_PLATFORM_OS`/`ARCH` (default: `linux/amd64`).
- **Streaming conversion** – The `docker save` tarball is parsed as a stream (no filesystem): modern OCI-layout tarballs are converted with large blobs streamed straight into storage; classic tarballs are gzipped/hashed in memory (with size guards).
- **Built-in landing page** – The root route serves an interactive landing page as Workers Static Assets (see [`public/`](public/)).
- **Cron-based cleanup** – In R2 mode, a Cron Trigger keeps the bucket under `CACHE_MAX_SIZE` (no long-running timers).

---

## 🏗 Architecture Overview

```
┌─────────────────┐        ┌────────────────────────────┐
│  Docker Client  │ ─────► │   Cloudflare Worker        │
│  (pull, build)  │ ◄───── │   src/index.js (fetch)     │
└─────────────────┘        │   ├─ routes/v2.js          │
                           │   ├─ services/registry.js  │
                           │   ├─ services/converter.js │
                           │   └─ storage/              │
                           └───────┬──────────┬─────────┘
                                   │          │
                     ┌─────────────▼───┐  ┌───▼──────────────┐
                     │  Source Service │  │  Cache            │
                     │  dockerimagesave│  │  - edge (default) │
                     │  .akiel.dev     │  │  - R2 (optional) │
                     └─────────────────┘  └──────────────────┘
```

Project layout:

```
src/
├── index.js               ← Worker entry (fetch + scheduled/cron)
├── routes/v2.js           ← Docker Registry v2 API (runtime-agnostic)
├── services/
│   ├── registry.js        ← business logic (resolve, fallback, dedup)
│   ├── converter.js       ← streaming tar → registry v2 layout
│   ├── fetcher.js         ← source service download (streaming)
│   └── registries.js      ← upstream registry list
├── storage/
│   ├── transient.js       ← Cache API store (default, cache off)
│   ├── r2.js              ← R2 store (durable, opt-in)
│   └── memory.js          ← in-memory store (tests / fallback)
└── utils/
    ├── tar.js             ← streaming tar parser (no dependencies)
    └── sha256.js          ← WebCrypto digest helpers

public/                    ← landing page (Workers Static Assets)
tests/                     ← node --test unit tests
```

---

## 📦 Getting Started

### Prerequisites

- Node.js ≥ 18 (for `wrangler` and the test suite)
- A Cloudflare account (free tier works)
- Network access from Workers to the source service and upstream registries

### Run locally

```bash
git clone https://github.com/sadra824/internal-docker-registry.git
cd internal-docker-registry
npm install
npx wrangler dev
```

The proxy is now at `http://localhost:8787`:

```bash
docker pull localhost:8787/library/nginx:latest
```

Opening `http://localhost:8787` in a browser shows the built-in landing page.

### Deploy

```bash
npx wrangler login
npx wrangler deploy
```

The Worker gets a `*.workers.dev` URL; attach a custom domain (Workers → Settings → Domains & Routes) and pull through it, e.g. `docker pull registry.sadhanet.com/library/nginx:latest`.

### Enable durable caching (R2)

```bash
npx wrangler r2 bucket create registry-cache
```

Then in [`wrangler.jsonc`](wrangler.jsonc):

1. Uncomment the `r2_buckets` block (binding `REGISTRY_BUCKET`).
2. Set `CACHE_ENABLED` to `"true"`.
3. Optionally set `CACHE_MAX_SIZE` (e.g. `"10GB"`) and uncomment the `triggers.crons` block so a scheduled cleanup keeps the bucket under the limit.

### Run tests

```bash
npm test
```

---

## ⚙️ Configuration

All settings come from Worker environment variables (Vars in `wrangler.jsonc`, or the dashboard) — read via `env.X`, not `process.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `CACHE_ENABLED` | Enable the durable R2 cache. **Default: off.** | `false` |
| `REGISTRY_BUCKET` | R2 bucket binding (required when `CACHE_ENABLED=true`) | — |
| `SOURCE_BASE_URL` | Source service endpoint for downloading images | `https://dockerimagesave.akiel.dev/image` |
| `DEFAULT_PLATFORM_OS` | Default OS for multi‑arch images | `linux` |
| `DEFAULT_PLATFORM_ARCH` | Default architecture | `amd64` |
| `TRANSIENT_TTL_SECONDS` | TTL of the transient edge cache (cache-off mode) | `1800` |
| `CACHE_MAX_SIZE` | Max R2 blob budget for cron cleanup (e.g. `10GB`, `500MB`) | `0` (unlimited) |
| `REGISTRIES_JSON` | JSON array overriding the upstream registry list | built-in list |
| `FETCH_TIMEOUT_MS` | Timeout for source-service fetches | `60000` |

---

## 🔄 How It Works

1. **Pull request** – The Docker client sends `GET /v2/<image>/manifests/<tag>` to the Worker.
2. **Cache lookup** – The proxy checks the active store (edge cache by default, R2 when enabled) for the manifest digest (by tag or digest reference).
   - If **cached**, it is served immediately.
   - If **not cached**, the proxy fetches from upstream.
3. **Fetching** – Every configured upstream registry is tried **in order, one at a time** via `SOURCE_BASE_URL?name=<registry>/<image>:<tag>`; the first success wins (duplicate concurrent pulls are deduplicated per isolate).
4. **Streaming conversion** – The downloaded tarball is parsed as a stream:
   - **OCI layout** (modern `docker save`): blobs are already content-addressed; large blobs stream directly into storage, only small JSON metadata is buffered. For multi-arch images, blobs of other platforms are pruned after platform selection.
   - **Classic `docker save`**: layers are gzipped and hashed in memory (capped at ~96 MB total).
5. **Storage** – Blobs and manifests are written to the transient edge cache (TTL) or R2 (durable).
6. **Response** – Manifests and blobs are streamed to the Docker client, which assembles the image.

---

## 🗄 Cache Modes & Storage Layout

| Mode | Store | Persistence | Cleanup |
|------|-------|-------------|---------|
| `CACHE_ENABLED=false` (default) | Cache API (edge) | Best-effort, per-PoP | Automatic TTL (`TRANSIENT_TTL_SECONDS`) |
| `CACHE_ENABLED=true` | R2 bucket | Durable, global | Cron Trigger enforces `CACHE_MAX_SIZE` (oldest-uploaded blobs are removed first; R2 does not track last-access, so eviction is upload-order FIFO rather than true LRU) |

R2 key layout:

```
blobs/sha256/<hex>      # layer and config blobs (streamed)
manifests/<hex>         # manifest JSON (+ mediaType in custom metadata)
tags/<repository>       # JSON map: tag → manifest digest
origins/<repository>    # winning upstream registry (for debugging)
```

---

## 🔌 API Endpoints (Docker Registry v2)

- `GET /v2/` – Version check
- `GET /v2/healthz` – Liveness probe
- `GET /v2/<name>/manifests/<reference>` – Get manifest (tags and digests)
- `HEAD /v2/<name>/manifests/<reference>` – Manifest metadata
- `GET /v2/<name>/blobs/<digest>` – Get blob (layer); streamed from cache
- `HEAD /v2/<name>/blobs/<digest>` – Check blob existence
- `GET /v2/<name>/tags/list` – List tags (durable mode only; empty when caching is off)
- `POST /v2/…/blobs/uploads/` – **501 Not Implemented** – this is a read-only proxy

All other endpoints (push, delete, etc.) are **not** supported.

---

## 🐳 Usage Example

Pull an image through the proxy:

```bash
docker pull localhost:8787/library/nginx:latest        # wrangler dev
docker pull registry.sadhanet.com/library/nginx:latest  # deployed
```

Or use it as a mirror in your Docker daemon configuration:

```json
{
  "registry-mirrors": ["https://registry.sadhanet.com"]
}
```

---

## ⚠️ Limitations & Considerations

- **Push not supported** – Pull-through cache only.
- **Source-service dependency** – The proxy cannot fetch directly from public registries; it relies on `SOURCE_BASE_URL`.
- **Classic-format size cap** – Legacy (non-OCI) `docker save` tarballs are converted in memory; total buffered data is capped at ~96 MB per conversion. Modern OCI-layout tarballs (the default since Docker 25) stream without this limit.
- **Workers limits** – CPU time and subrequest quotas depend on your plan; large images on the free tier's CPU budget may be slow. Blob responses are streamed, so memory stays bounded for OCI images.
- **First pull latency** – The initial pull downloads and converts the tarball before responding.

---

## 🔧 Troubleshooting

| Issue | Possible Solution |
|-------|-------------------|
| `404 MANIFEST_UNKNOWN` | The image doesn't exist in any configured registry — check the error details and `REGISTRIES_JSON`. |
| `500 CONFIG_ERROR` | `CACHE_ENABLED=true` but the `REGISTRY_BUCKET` R2 binding is missing — enable it in `wrangler.jsonc`. |
| `502`-like fetch failures | The source service (`SOURCE_BASE_URL`) is unreachable or returned an error. |
| R2 cache doesn't shrink | Verify `CACHE_MAX_SIZE` is set and the `triggers.crons` block is uncommented; check the Cron Trigger logs. |
| Slow first pull | Expected — conversion happens on first request; subsequent pulls are served from cache. |

Debug with live logs:

```bash
npx wrangler tail
```

---

## 🏠 Landing Page

The Worker serves a self-contained landing page at `/` that documents how the project works. The UI is in **Persian (RTL)** and styled with the corporate palette (`#045F99`, `#1A1A1A`, `#092332`, `#E7F1FA`) plus the organization logo:

- **Hero with a live terminal demo** – shows a first pull (fetch, convert, cache) followed by a cached pull.
- **Interactive pull simulator** – step through the request flow for a *cache miss* or *cache hit*.
- **Feature grid, quick-start snippets** (with copy buttons), and the **API endpoint reference**.

It lives in [`public/`](public/) as plain HTML, CSS, and JavaScript — served by **Workers Static Assets** (no `express.static`).

```
public/
├── index.html   # ساختار و محتوا (فارسی، راست‌به‌چپ)
├── logo.svg     # لوگوی سازمان
├── styles.css   # تم روشن با پالت سازمانی + تنظیمات فونت اختصاصی
├── script.js    # انیمیشن ترمینال، شبیه‌ساز pull، دکمه‌های کپی
└── fonts/       # فونت یکان بخ (YekanBakhFaNum-*.woff2) را اینجا بگذارید
```

### Custom brand font (YekanBakh)

`styles.css` declares `@font-face` rules for the **YekanBakh** brand font. To enable it, drop the WOFF2 files into `public/fonts/` with these names — no code changes needed:

| File | Weight |
|------|--------|
| `YekanBakhFaNum-Thin.woff2` | 100 |
| `YekanBakhFaNum-Light.woff2` | 300 |
| `YekanBakhFaNum-Regular.woff2` | 400 |
| `YekanBakhFaNum-SemiBold.woff2` | 600 |
| `YekanBakhFaNum-Bold.woff2` | 700 |
| `YekanBakhFaNum-ExtraBold.woff2` | 800 |
| `YekanBakhFaNum-Black.woff2` | 900 |
| `YekanBakhFaNum-ExtraBlack.woff2` | 950 |

Until the files exist, the page gracefully falls back to **Vazirmatn** (loaded from Google Fonts, with system-font fallbacks).

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or pull request for bug fixes, performance improvements, better multi-architecture handling, or enhanced cache strategies. Run `npm test` before submitting.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

**Happy caching — now at the edge! 🚀**

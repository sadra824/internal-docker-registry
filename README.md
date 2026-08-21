# Sadhanet Docker Registry — on Cloudflare Workers

A lightweight image-distribution service that runs on **Cloudflare Workers** and sits between your Docker tooling and upstream registries. Two modes are available, **both storage-free and near-zero CPU** (they run comfortably on the Workers **free plan**):

- **Direct download:** `GET /image?name=nginx:latest` streams the `docker save` tarball straight from the source service to the client — no storage, no processing, resume-friendly (`wget -c`). Load it with `docker load`.
- **Registry v2 API (`/v2/…`):** full manifest/blob compatibility for `docker pull`, `podman`, Kubernetes mirrors, etc. The manifest is assembled from the tarball's small metadata only (digests are embedded in the OCI blob paths), and layers are piped through byte-by-byte — no hashing, no buffering, no storage.

> **Nothing is stored.** No disk, no Cache API, no R2, no cron. Only a few kilobytes of manifest metadata are kept in isolate memory for ~10 minutes so the requests of a single `docker pull` don't refetch the manifest.

---

## ✨ Features

- **Direct pass-through downloads** – `GET /image?name=…` streams the tarball straight to the client with zero processing and zero storage; `Range` requests (`wget -c`) supported for resumable downloads. Runs comfortably on the free plan.
- **Docker Registry API v2 compliant** – Works seamlessly with `docker pull`, `docker build`, Kubernetes, and other container tools — manifest built on the fly from tarball metadata, layers streamed through untouched.
- **Runs on Cloudflare Workers** – No permanent server, no infrastructure to manage; every request executes at the edge. No `fs`, no `listen`, no `setInterval`.
- **Storage-free by design** – Nothing is written anywhere; per-isolate manifest metadata (a few KB, 10-minute TTL) is the only state.
- **Multi‑registry fallback** – Tries a prioritized list of upstream registries (`docker.arvancloud.ir`, `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `mcr.microsoft.com`, …) in order; the first success wins.
- **Multi‑architecture support** – Selects the platform via `os`/`arch`/`variant` (query params on `/image`, `DEFAULT_PLATFORM_*` vars for `/v2`; default: `linux/amd64`). `GET /platforms?name=…` lists what an image supports.
- **Built-in landing page** – The root route serves an interactive landing page as Workers Static Assets (see [`public/`](public/)).

---

## 🏗 Architecture Overview

```
┌─────────────────┐        ┌────────────────────────────┐
│  Docker Client  │ ─────► │   Cloudflare Worker        │
│  (pull / wget)  │ ◄───── │   src/index.js (fetch)     │
└─────────────────┘        │   ├─ routes/v2.js          │
                           │   ├─ routes/passthrough.js │
                           │   ├─ services/registry.js  │
                           │   ├─ services/tarscan.js   │
                           │   └─ services/fetcher.js   │
                           └───────────┬────────────────┘
                                       │
                            ┌──────────▼───────────┐
                            │  Source Service      │
                            │  dockerimagesave     │
                            │  .akiel.dev          │
                            └──────────────────────┘
```

Project layout:

```
src/
├── index.js               ← Worker entry
├── routes/
│   ├── v2.js              ← Docker Registry v2 API (streaming, storage-free)
│   └── passthrough.js     ← GET /image + /platforms (zero-CPU pass-through)
├── services/
│   ├── registry.js        ← manifest from tarball metadata; blob piping
│   ├── tarscan.js         ← zero-copy streaming tar scanner
│   ├── fetcher.js         ← source service download (streaming)
│   └── registries.js      ← upstream registry list
└── utils/
    └── sha256.js          ← WebCrypto digest helpers (small buffers only)

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

Not applicable — this service stores nothing (see below). If you ever need a durable pull-through cache, R2 support can be reintroduced, but the current design is deliberately storage-free for near-zero CPU on the free plan.

### Run tests

```bash
npm test
```

---

## ⚙️ Configuration

All settings come from Worker environment variables (Vars in `wrangler.jsonc`, or the dashboard) — read via `env.X`, not `process.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `SOURCE_BASE_URL` | Source service endpoint for downloading images | `https://dockerimagesave.akiel.dev/image` |
| `DEFAULT_PLATFORM_OS` | Default OS for multi‑arch images (`/v2` mode) | `linux` |
| `DEFAULT_PLATFORM_ARCH` | Default architecture (`/v2` mode) | `amd64` |
| `DEFAULT_PLATFORM_VARIANT` | Default variant, e.g. `v7` (`/v2` mode, optional) | — |
| `REGISTRIES_JSON` | JSON array overriding the upstream registry list | built-in list |
| `FETCH_TIMEOUT_MS` | Timeout for source-service fetches | `120000` |

---

## 🔄 How It Works

### `/v2` mode (docker pull)

1. **Manifest request** – The Docker client sends `GET /v2/<image>/manifests/<tag>`. The Worker fetches the tarball from the source service (registries tried in order) and reads **only its small metadata**: `manifest.json` plus each member's tar header (name + size). Reading stops as soon as everything needed is seen.
2. **Manifest assembly** – Because the tarball is OCI-layout, every blob's digest is embedded in its path (`blobs/sha256/<hex>`). The v2 manifest (config + layer descriptors with real digests/sizes) is assembled in milliseconds — no hashing, no layer buffering.
3. **Blob requests** – For each layer, Docker sends `GET /v2/<image>/blobs/<digest>`. Response headers go out immediately (no client-side timeout risk) and the layer's bytes are **piped through byte-by-byte** from the source tarball — zero-copy, no storage. The tag↔manifest mapping (a few KB) is kept in isolate memory for 10 minutes so blob requests know which reference to fetch.
4. **Deduplication** – Concurrent identical manifest requests share one fetch per isolate.

### `/image` mode (wget | docker load)

`GET /image?name=nginx:latest` (with optional `os`/`arch`/`variant`) proxies the source service directly: headers are forwarded (including `Content-Disposition` and `Range` for `wget -c` resume) and the tarball streams straight through. `GET /platforms?name=…` lists the available platforms of an image.

---

## 🔌 API Endpoints

### Direct download (recommended — free-plan friendly)

- `GET /image?name=<ref>` – Stream the image tarball (`docker save` format) directly to the client; pass-through, resumable via `Range`/`wget -c`
- `GET /image?name=<ref>&os=linux&arch=arm64&variant=v8` – Select a specific platform (default `linux/amd64`)
- `GET /platforms?name=<ref>` – List available platforms for an image

```bash
# stream straight into docker:
wget -q -O - "https://registry.example.com/image?name=nginx:latest" | docker load

# resumable download, then load:
wget -c --content-disposition "https://registry.example.com/image?name=nginx:latest"
docker load -i nginx_latest.tar
```

If `name` starts with a registry host (e.g. `ghcr.io/owner/img:tag`), only that registry is used; otherwise registries are tried in order and the first success wins.

### Docker Registry v2 (heavier — needs CPU headroom for large images)

- `GET /v2/` – Version check
- `GET /v2/healthz` – Liveness probe
- `GET /v2/<name>/manifests/<reference>` – Get manifest (tags and digests)
- `HEAD /v2/<name>/manifests/<reference>` – Manifest metadata
- `GET /v2/<name>/blobs/<digest>` – Get blob (layer); piped through from the source tarball
- `HEAD /v2/<name>/blobs/<digest>` – Check blob existence
- `GET /v2/<name>/tags/list` – List tags (always empty — nothing is stored)
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

- **Push not supported** – Pull-through only.
- **Source-service dependency** – The proxy cannot fetch directly from public registries; it relies on `SOURCE_BASE_URL`.
- **OCI layout only** – The `/v2` mode reads digests from `blobs/sha256/<hex>` paths; classic (pre-Docker-25) `docker save` tarballs are rejected with a clear error. The `/image` mode works with any format since it passes bytes through untouched.
- **Per-blob source fetches** – Without storage, every blob request re-downloads the source tarball (headers are answered immediately; bytes stream through). Bandwidth-heavy but CPU-free; the source service must tolerate it.
- **Isolate memory scope** – The tag↔manifest memo lives per isolate (~10 min). If an isolate recycles between manifest and blob requests, the blob returns 404 and the pull restarts — docker handles this gracefully on retry.
- **Subrequest/CPU quotas** – Both modes are near-zero CPU and work on the free plan; very large images may still take a while because the source service itself builds the tarball.

---

## 🔧 Troubleshooting

| Issue | Possible Solution |
|-------|-------------------|
| `404 MANIFEST_UNKNOWN` | The image doesn't exist in any configured registry — check the error details and `REGISTRIES_JSON`. |
| `500 CONFIG_ERROR` | Check the error message — usually a malformed `REGISTRIES_JSON`. |
| `502`-like fetch failures | The source service (`SOURCE_BASE_URL`) is unreachable or returned an error. |
| Blob 404 after isolate recycle | Expected occasionally — nothing is stored; retry the pull and the manifest is re-fetched. |
| Slow first pull | Expected — the source service must build the tarball on first request; bytes then stream through. Subsequent pulls reuse docker's local layer cache. |

Debug with live logs:

```bash
npx wrangler tail
```

---

## 🏠 Landing Page

The Worker serves a self-contained landing page at `/` that documents how the project works. The UI is in **Persian (RTL)** and styled with the corporate palette (`#045F99`, `#1A1A1A`, `#092332`, `#E7F1FA`) plus the organization logo:

- **Hero with a live terminal demo** – shows docker pull plus a resumable wget | docker load download.
- **Interactive download simulator** – step through the request flow (registry fallback, direct streaming).
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

Contributions are welcome! Please open an issue or pull request for bug fixes, performance improvements, better multi-architecture handling, or storage-free distribution improvements. Run `npm test` before submitting.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

**Happy caching — now at the edge! 🚀**

# Docker Registry Proxy v2

A lightweight, caching proxy for the Docker Registry API v2 that sits between your Docker client and upstream registries. It fetches images from a configurable source service, caches them on disk, and serves subsequent requests with low latency—reducing bandwidth usage and dependency on external registries.

---

## ✨ Features

- **Built-in landing page** – The root route (`/`) serves a small interactive landing page (plain HTML/CSS/JS, no dependencies) that explains how the proxy works, with a pull simulator, quick-start snippets, and the API reference. See [`public/`](public/).
- **Docker Registry API v2 compliant** – Works seamlessly with `docker pull`, `docker build`, Kubernetes, and other container tools.
- **Intelligent caching** – Stores blobs (layers) and manifests on disk with configurable size limits and automatic cleanup.
- **Multi‑registry fallback** – Tries a prioritized list of upstream registries (`docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `mcr.microsoft.com`, etc.) until the image is found.
- **Multi‑architecture support** – Automatically selects the appropriate platform variant based on `DEFAULT_PLATFORM_OS`/`ARCH` (default: `linux/amd64`).
- **Automatic format conversion** – Handles both modern OCI layout and classic `docker save` tarballs, extracting and re‑packing layers on the fly.
- **Transient (cache‑less) mode** – Store images in a temporary directory with auto‑eviction after 30 minutes of inactivity—ideal for ephemeral environments.
- **LRU eviction** – When cache size limit is reached, the least recently used blobs are removed first.
- **Lightweight & fast** – Built with Node.js and Express, requires minimal resources.

---

## 🏗 Architecture Overview

```
┌─────────────────┐      ┌───────────────────────┐      ┌─────────────────┐
│  Docker Client  │ ──► │  Registry Proxy (v2)   │ ──► │  Cache (disk)   │
│  (pull, build)  │ ◄── │  - Express server      │ ◄── │  - blobs/       │
└─────────────────┘      │  - Route handlers     │      │  - manifests/   │
                         │  - Fetcher module     │      │  - tags.json    │
                         │  - Converter module   │      └─────────────────┘
                         │  - Store manager      │
                         └──────────┬────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │  Source Service     │
                         │  (dockerimagesave.  │
                         │   akiel.dev/image)  │
                         └─────────────────────┘
```

---

## 📦 Getting Started

### Prerequisites

- Node.js ≥ 18 (or Docker)
- At least 10 GB of free disk space (adjustable)
- Network access to the source service and upstream registries

### Quick Start with Docker Compose

```bash
git clone https://github.com/sadra824/internal-docker-registry.git
cd internal-docker-registry
docker-compose up -d
```

The proxy will be available at `http://localhost:5000`. Opening it in a browser shows the built-in landing page (see below); `docker` clients talk to the same host on the `/v2` API.

### Manual Start (Node.js)

```bash
npm install
cp .env.example .env   # edit variables if needed
npm start
```

---

## ⚙️ Configuration

All settings are controlled via environment variables. See `.env.example` for a complete list.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Listening port | `5000` |
| `DATA_DIR` | Persistent cache directory | `./data` |
| `SOURCE_BASE_URL` | Source service endpoint for downloading images | `https://dockerimagesave.akiel.dev/image` |
| `DEFAULT_PLATFORM_OS` | Default OS for multi‑arch images | `linux` |
| `DEFAULT_PLATFORM_ARCH` | Default architecture | `amd64` |
| `CACHE_ENABLED` | Enable/disable persistent cache | `true` |
| `CACHE_MAX_SIZE` | Maximum cache size (e.g., `10GB`, `500MB`) | `0` (unlimited) |
| `CACHE_CLEANUP_INTERVAL` | How often to run cache cleanup (e.g., `1h`, `30m`) | `1h` |
| `NODE_ENV` | Set to `production` for optimized performance | `development` |

> **Note:** The `registries.json` file contains the ordered list of upstream registries. You can modify it to add/remove/prioritize sources.

---

## 🏠 Landing Page

The proxy serves a self-contained landing page at `/` that documents how the project works. The UI is in **Persian (RTL)** and styled with the corporate palette (`#045F99`, `#1A1A1A`, `#092332`, `#E7F1FA`) plus the organization logo:

- **Hero with a live terminal demo** – shows a first pull (fetch, convert, cache) followed by a cached pull.
- **Interactive pull simulator** – step through the request flow for a *cache miss* (registry fallback via the source service → tarball conversion → storage) or a *cache hit* (served straight from disk).
- **Feature grid, quick-start snippets** (with copy buttons), and the **API endpoint reference**.

It lives in [`public/`](public/) as plain HTML, CSS, and JavaScript — no build step — and is served by Express via `express.static`, without interfering with the `/v2` API.

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

## 🔄 How It Works

1. **Pull request** – Docker client sends a `GET /v2/<image>/manifests/<tag>` to the proxy.
2. **Cache lookup** – The proxy checks if the manifest and all associated blobs exist in the cache.
   - If **cached**, it serves the response immediately.
   - If **not cached**, it proceeds to fetch from upstream.
3. **Fetching** – The proxy queries each registry in `registries.json` sequentially, using `SOURCE_BASE_URL?name=<registry>/<image>:<tag>`.
4. **Conversion** – The downloaded file (a `docker save` tarball) is extracted and converted into the standard registry v2 layout:
   - Blobs are stored content‑addressed under `sha256:<digest>`.
   - Manifests are indexed and saved.
5. **Storage** – All data is written to `DATA_DIR` (or a temporary directory in transient mode).
6. **Response** – The proxy serves the manifest and blob data to the Docker client, which then assembles the image.

---

## 📁 Cache Directory Structure

```
DATA_DIR/
├── blobs/
│   └── sha256/               # Each blob file is named by its digest (without "sha256:")
├── manifests/                # Manifest files (.json) and metadata (.meta)
├── tags.json                 # Mapping of (repository, tag) → manifest digest
└── origins.json              # Registry source for each image (for debugging)
```

---

## 🔌 API Endpoints (Docker Registry v2)

The proxy implements the mandatory endpoints:

- `GET /v2/` – Version check
- `GET /v2/<name>/manifests/<reference>` – Get manifest (supports tags and digests)
- `GET /v2/<name>/blobs/<digest>` – Get blob (layer)
- `HEAD /v2/<name>/blobs/<digest>` – Check if blob exists
- `GET /v2/<name>/tags/list` – List tags (optional, but implemented)

All other endpoints (e.g., upload, delete) are **not** supported – this is a read‑only proxy.

---

## 🧹 Cache Management

- **Eviction policy** – LRU (Least Recently Used) based on file access time.
- **Automatic cleanup** – Runs every `CACHE_CLEANUP_INTERVAL`; removes blobs until total size is below `CACHE_MAX_SIZE`.
- **Manual cleanup** – Delete the `DATA_DIR` or individual files to reset the cache.

In **transient mode** (`CACHE_ENABLED=false`), images are stored in `/tmp/registry-cache-<random>` and removed automatically after 30 minutes of inactivity.

---

## 🐳 Usage Example

Pull an image through the proxy:

```bash
docker pull localhost:5000/library/nginx:latest
```

You can also use it as a mirror in your Docker daemon configuration:

```json
{
  "registry-mirrors": ["http://localhost:5000"]
}
```

---

## ⚠️ Limitations & Considerations

- **Push not supported** – This is a pull‑through cache only. You cannot push images to it.
- **Dependency on source service** – The proxy cannot fetch images directly from public registries; it relies on `SOURCE_BASE_URL` to provide `docker save` output.
- **Network latency** – The first pull of an image will be slower because it must download and convert the tarball.
- **Disk space** – Ensure `DATA_DIR` has enough free space; otherwise, the cache cleanup may fail.

---

## 🔧 Troubleshooting

| Issue | Possible Solution |
|-------|-------------------|
| `404 Not Found` | Check that the image exists in at least one of the registries listed in `registries.json`. |
| `502 Bad Gateway` | The source service (`SOURCE_BASE_URL`) is unreachable or returned an invalid response. |
| Cache doesn't shrink | Verify `CACHE_MAX_SIZE` is set correctly and that cleanup interval is running. |
| Docker client hangs | Ensure the proxy is reachable and that the Docker daemon is configured to use HTTP (not HTTPS) for local registries. |

Enable debug logging by setting `LOG_LEVEL=debug` (if supported) or check the container logs:

```bash
docker logs -f <container-id>
```

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or pull request for:

- Bug fixes and performance improvements
- Support for additional registry APIs
- Better multi‑architecture handling
- Enhanced cache algorithms

Ensure your code passes the existing tests and follows the project's coding style.

---

## 📄 License

This project is licensed under the MIT License – see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgements

Built with ❤️ using [Express](https://expressjs.com/), [node-fetch](https://github.com/node-fetch/node-fetch), and the Docker community.

---

**Happy caching! 🚀**
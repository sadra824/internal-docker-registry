# Sadhanet Docker Registry

A private container registry on **Cloudflare Workers**, with two ways to get images:

- **`/v2/…` — the registry itself.** Powered by [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry) (vendored under `vendor/serverless-registry/`, Apache-2.0) running in **storage-free pull-through mode**: every manifest/blob is fetched from the configured upstream registries (e.g. ArvanCloud / Docker Hub) and streamed straight to the client. **No authentication** — anonymous pulls; **nothing is ever stored** (no R2, no cache — the storage writes are no-ops) and **push is disabled** (501). Single-segment names (e.g. `nginx`) are normalized to `library/nginx` just like the Docker client does for Docker Hub.
- **`/image?name=…` — direct download.** Streams the `docker save` tarball from the source service (`dockerimagesave.akiel.dev`) straight to the client with zero processing — resumable with `wget -c`, loadable with `docker load`, no storage involved. Registry fallback across 13 upstreams is built in, plus `GET /platforms?name=…` for listing available platforms.

> No storage anywhere: `/v2` streams everything from upstream on every request, `/image` streams from the source service. There is no R2 bucket, no cache, no persistence.

---

## ✨ Features

- **Registry v2 pull API** – `docker pull` / `_catalog` / referrers — the vendored serverless-registry handles it all.
- **Pull-through, storage-free** – `REGISTRIES_JSON` lists 12 anonymous upstream registries (ArvanCloud, Docker Hub, ghcr.io, registry.k8s.io, quay.io, gcr.io, public.ecr.aws, mcr.microsoft.com, registry.gitlab.com, nvcr.io, icr.io, Alibaba); every request is streamed from upstream and nothing is kept.
- **Anonymous pulls** – no `docker login` needed; auth has been removed entirely.
- **Direct pass-through downloads** – `GET /image?name=…` with `Range`/`wget -c` resume support; `GET /platforms?name=…`.
- **Multi‑registry fallback** – 13 upstreams tried in order (`docker.arvancloud.ir`, `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `mcr.microsoft.com`, …).
- **Multi‑architecture** – `os`/`arch`/`variant` selection on both paths.
- **Built-in landing page** – Persian/RTL, corporate palette, served as Workers Static Assets.

---

## 🏗 Architecture

```
┌─────────────────┐   /v2/*   ┌──────────────────────────────┐
│  Docker Client  │ ────────► │ vendor/serverless-registry   │
│  (login/pull)   │ ◄──────── │ (auth + OCI dist API)        │
└─────────────────┘           └───────────┬──────────────────┘
                                          │ every request, streamed
                                          ▼
                              upstream registries (fallback list)
                                          (no R2, no storage)

┌─────────────────┐  /image   ┌──────────────────────────────┐
│  wget / curl    │ ────────► │ src/routes/passthrough.js    │ ──► source service
│  (docker load)  │ ◄──────── │ (zero-CPU stream, resume)    │ ◄── (dockerimagesave)
└─────────────────┘           └──────────────────────────────┘
```

```
src/
├── index.js               ← entry: /v2 → vendored registry, /image → passthrough
├── registry-nocache.js    ← storage-free Registry + empty-bucket shim
├── routes/passthrough.js  ← GET /image + /platforms
└── services/registries.js ← upstream list for /image

vendor/serverless-registry/  ← cloudflare/serverless-registry (Apache-2.0, unmodified)
public/                      ← landing page (Static Assets)
tests/                       ← node --test unit tests
```

---

## 📦 Getting Started

### Prerequisites

- Node.js ≥ 18 (for `wrangler` and tests)
- A Cloudflare account (free plan is enough — no R2 or storage setup needed)

### 1. Run / deploy (no credentials needed — pulls are anonymous)

```bash
npm install
npm start          # local dev on :5000 (credentials via .dev.vars)
npx wrangler deploy
```

### 2. Use it

```bash
docker pull registry.sadhanet.com/nginx                  # library/ prefix added automatically
docker pull registry.sadhanet.com/library/nginx:latest   # explicit form works too

# or the storage-free direct download:
wget -c --content-disposition "https://registry.sadhanet.com/image?name=redis:7"
docker load -i redis_7.tar
```

### Tests

```bash
npm test
```

---

## ⚙️ Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `REGISTRIES_JSON` | `/v2` pull-through upstream list — `[{"registry":"https://index.docker.io/", "username"?:…, "password_env"?:…}]` | set in `wrangler.jsonc` (12 anonymous registries) |
| `PASSTHROUGH_REGISTRIES_JSON` | `/image` upstream hostnames | built-in list of 13 |
| `SOURCE_BASE_URL` | Source service for `/image` | `https://dockerimagesave.akiel.dev/image` |

See [`wrangler.jsonc`](wrangler.jsonc) for inline comments; upstream docs for [serverless-registry](https://github.com/cloudflare/serverless-registry) cover the registry-specific options in depth.

---

## 🔌 API Endpoints

**Registry (v2):** `GET /v2/`, `GET /v2/_catalog`, `GET|HEAD /v2/<name>/manifests/<ref>`, `GET|HEAD /v2/<name>/blobs/<digest>`, `GET /v2/<name>/tags/list`, referrers — all anonymous; write operations return `501`.

**Direct download:** `GET /image?name=<ref>[&os=&arch=&variant=]`, `GET /platforms?name=<ref>`, `Range` requests for resume.

---

## ⚠️ Limitations & Considerations

- **Anonymous & read-only** — no login; writes (push/mount/delete) return `501`. — push/mount/delete return `501`; with no storage there is nowhere to write.
- **Every blob request re-fetches** the manifest+blob from upstream (headers answered from the upstream manifest check; bytes stream through) — bandwidth-heavy but CPU-light and storage-free.
- **Docker Hub rate limits** — anonymous fallback pulls share quota; set `username`/`password_env` in `REGISTRIES_JSON` to avoid them.
- **Docker Hub rate limits** — anonymous fallback pulls share quota; set `username`/`password_env` in `REGISTRIES_JSON` to avoid them.
- `/image` depends on `SOURCE_BASE_URL` being reachable.

---

## 🏠 Landing Page

The Worker serves a self-contained landing page at `/` (Persian/RTL, corporate palette `#045F99`/`#1A1A1A`/`#092332`/`#E7F1FA`, YekanBakh font in `public/fonts/`). It documents the pull and direct-download flows interactively. See [`public/`](public/).

---

## 📄 Licenses

- This repository: MIT.
- [`vendor/serverless-registry/`](vendor/serverless-registry/): Apache License 2.0 — © Cloudflare, unmodified vendored copy of [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry). It is used here without its R2 storage: `src/registry-nocache.js` replaces the storage client with a stateless pull-through implementation (all vendor files remain unmodified).

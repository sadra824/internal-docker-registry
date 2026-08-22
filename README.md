# Sadhanet Docker Registry

A private container registry on **Cloudflare Workers**, with two ways to get images:

- **`/v2/…` — the registry itself.** Powered by [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry) (vendored under `vendor/serverless-registry/`, Apache-2.0): full OCI distribution support (pull **and** push) on top of **R2**, with username/password or JWT authentication, and **pull-through fallback** — if an image isn't in R2 yet, it is fetched from a configured upstream registry (e.g. Docker Hub / ArvanCloud) and stored, so the next pull is served straight from R2.
- **`/image?name=…` — direct download.** Streams the `docker save` tarball from the source service (`dockerimagesave.akiel.dev`) straight to the client with zero processing — resumable with `wget -c`, loadable with `docker load`, no storage involved. Registry fallback across 13 upstreams is built in, plus `GET /platforms?name=…` for listing available platforms.

> No custom caching layer anywhere: `/v2` uses R2 as its storage (that's the registry itself, not a cache), and `/image` stores nothing at all.

---

## ✨ Features

- **Full Registry v2 API** – `docker pull` / `docker push` / `_catalog` / referrers — the vendored serverless-registry handles it all.
- **Pull-through fallback** – `REGISTRIES_JSON` lists upstream registries (anonymous or authenticated); missing images are fetched once and kept in R2.
- **Authentication** – `USERNAME`/`PASSWORD` (plus optional read-only credentials) or JWT public key; requests without credentials get `401`.
- **Direct pass-through downloads** – `GET /image?name=…` with `Range`/`wget -c` resume support; `GET /platforms?name=…`.
- **Multi‑registry fallback** – 13 upstreams tried in order (`docker.arvancloud.ir`, `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `mcr.microsoft.com`, …).
- **Multi‑architecture** – `os`/`arch`/`variant` selection on both paths.
- **Built-in landing page** – Persian/RTL, corporate palette, served as Workers Static Assets.

---

## 🏗 Architecture

```
┌─────────────────┐   /v2/*   ┌──────────────────────────────┐     ┌─────────────┐
│  Docker Client  │ ────────► │ vendor/serverless-registry   │ ──► │ R2 bucket   │
│  (login/pull)   │ ◄──────── │ (auth + OCI dist API)        │ ◄── │ (storage)   │
└─────────────────┘           └───────────┬──────────────────┘     └─────────────┘
                                          │ on miss: pull-through
                                          ▼
                              upstream registries (fallback list)

┌─────────────────┐  /image   ┌──────────────────────────────┐
│  wget / curl    │ ────────► │ src/routes/passthrough.js    │ ──► source service
│  (docker load)  │ ◄──────── │ (zero-CPU stream, resume)    │ ◄── (dockerimagesave)
└─────────────────┘           └──────────────────────────────┘
```

```
src/
├── index.js               ← entry: /v2 → vendored registry, /image → passthrough
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
- A Cloudflare account. **Note:** R2 requires billing info on the account even on its free tier (10 GB storage, 1 M writes, 10 M reads per month — enough for a personal registry at no cost).

### 1. Create the R2 bucket

```bash
npx wrangler r2 bucket create sadhanet-registry
```

### 2. Set registry credentials (required — otherwise every /v2 request gets 401)

```bash
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD
# optional read-only credentials:
npx wrangler secret put READONLY_USERNAME
npx wrangler secret put READONLY_PASSWORD
```

### 3. Run / deploy

```bash
npm install
npm start          # local dev on :5000 (credentials via .dev.vars)
npx wrangler deploy
```

### 4. Use it

```bash
docker login registry.sadhanet.com -u <USERNAME> -p <PASSWORD>
docker pull registry.sadhanet.com/library/nginx:latest   # first pull fetches & stores in R2
docker pull registry.sadhanet.com/library/nginx:latest   # next pull: straight from R2

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
| `USERNAME` / `PASSWORD` | Registry credentials (secrets; **required** for `/v2`) | — |
| `READONLY_USERNAME` / `READONLY_PASSWORD` | Optional read-only credentials | — |
| `JWT_REGISTRY_TOKENS_PUBLIC_KEY` | Optional JWT auth (base64 public key) | — |
| `REGISTRIES_JSON` | `/v2` pull-through fallback list — `[{"registry":"https://index.docker.io/", "username"?:…, "password_env"?:…}]` | set in `wrangler.jsonc` (ArvanCloud + Docker Hub, anonymous) |
| `PASSTHROUGH_REGISTRIES_JSON` | `/image` upstream hostnames | built-in list of 13 |
| `SOURCE_BASE_URL` | Source service for `/image` | `https://dockerimagesave.akiel.dev/image` |

See [`wrangler.jsonc`](wrangler.jsonc) for inline comments; upstream docs for [serverless-registry](https://github.com/cloudflare/serverless-registry) cover the registry-specific options in depth.

---

## 🔌 API Endpoints

**Registry (v2):** `GET /v2/`, `GET /v2/_catalog`, `GET|HEAD|PUT|DELETE /v2/<name>/manifests/<ref>`, `GET|HEAD /v2/<name>/blobs/<digest>`, `POST|PATCH|PUT /v2/<name>/blobs/uploads/…`, referrers — all authenticated.

**Direct download:** `GET /image?name=<ref>[&os=&arch=&variant=]`, `GET /platforms?name=<ref>`, `Range` requests for resume.

---

## ⚠️ Limitations & Considerations

- **Auth is mandatory on `/v2`** — `docker login` before `docker pull` (this is a *private* registry).
- **R2 storage grows** as images are pulled through; the free tier covers 10 GB, and serverless-registry ships an [experimental garbage collector](https://github.com/cloudflare/serverless-registry/tree/main/docs) for cleanup.
- **Push layer cap** — layers up to ~500 MB per request (Workers body-size limit); see the upstream `push/` tooling for larger layers.
- **Docker Hub rate limits** — anonymous fallback pulls share quota; set `username`/`password_env` in `REGISTRIES_JSON` to avoid them.
- `/image` depends on `SOURCE_BASE_URL` being reachable.

---

## 🏠 Landing Page

The Worker serves a self-contained landing page at `/` (Persian/RTL, corporate palette `#045F99`/`#1A1A1A`/`#092332`/`#E7F1FA`, YekanBakh font in `public/fonts/`). It documents the pull and direct-download flows interactively. See [`public/`](public/).

---

## 📄 Licenses

- This repository: MIT.
- [`vendor/serverless-registry/`](vendor/serverless-registry/): Apache License 2.0 — © Cloudflare, unmodified vendored copy of [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry).

# Docker Save Registry Proxy

A Docker Registry v2-compatible proxy that retrieves images from the output of the `docker save` service, generates pullable manifests and blobs, and serves them to Docker clients.

## How It Works

The proxy acts as a bridge between Docker clients and the `dockerimagesave.akiel.dev` service:

```text
Docker Client
     │
     │ docker pull
     ▼
Docker Save Registry Proxy
     │
     │ fetch docker save archive
     ▼
dockerimagesave.akiel.dev
```

The upstream service can be queried directly:

```bash
wget -q -O - "https://dockerimagesave.akiel.dev/image?name=<image-registry>/<image-repository>/<image-name>:tag"
```

The proxy converts the resulting Docker image archive into a Docker Registry v2-compatible structure, including manifests and blobs.

## Getting Started

### Install and Run

```bash
npm install
npm start
```

By default, the application listens on port `5000`.

You can then pull an image through the proxy:

```bash
docker pull localhost:5000/library/nginx:latest
```

### Docker Compose

If you are using Docker Desktop, it is recommended to run the proxy inside Docker so that the registry is accessible to the Docker daemon:

```bash
docker compose up --build
```

## Configuration

Default configuration is provided in `.env`:

```env
APP_URL=localhost
APP_PORT=5000
HOST=::
DEFAULT_REGISTRY=docker.io
LOG_LEVEL=debug
UPSTREAM_TIMEOUT_MS=120000
```

### Environment Variables

| Variable              | Default                                   | Description                                                |
| --------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `APP_URL`             | `localhost`                               | Public host or domain of the application, without the port |
| `APP_PORT`            | `5000`                                    | HTTP port. If not set, `PORT` is used                      |
| `PORT`                | `5000`                                    | Fallback HTTP port                                         |
| `HOST`                | `::`                                      | Address the HTTP server listens on                         |
| `CACHE_DIR`           | `./data/cache`                            | Directory used to cache blobs and manifests                |
| `SAVE_IMAGE_URL`      | `https://dockerimagesave.akiel.dev/image` | Upstream service that generates the `docker save` archive  |
| `CACHE_TTL_SECONDS`   | `3600`                                    | How long tags remain fresh. `0` disables cache expiration  |
| `DEFAULT_REGISTRY`    | `docker.io`                               | Default registry for shortened image references            |
| `LOG_LEVEL`           | `debug`                                   | Log level: `debug`, `info`, `warn`, or `error`             |
| `UPSTREAM_TIMEOUT_MS` | `120000`                                  | Timeout for requests to the upstream image service         |

## Pulling Images

The proxy supports standard Docker Registry v2 image references.

### Full Reference

```bash
docker pull localhost:5000/library/nginx:latest
```

### Short Reference

For official Docker Hub images, you can omit `docker.io`:

```bash
docker pull localhost:5000/nginx:latest
```

The application uses:

```env
DEFAULT_REGISTRY=docker.io
```

to resolve the registry behind the scenes.

For example:

```bash
docker pull localhost:5000/library/nginx:latest
```

is resolved upstream as:

```text
https://dockerimagesave.akiel.dev/image?name=docker.io/library/nginx:latest
```

## Image Names

Docker determines the local image name from the reference used in the `docker pull` command.

For example:

```bash
docker pull localhost:5000/nginx:latest
```

will result in:

```bash
docker images
```

```text
REPOSITORY           TAG
localhost:5000/nginx latest
```

If you want the `library` namespace to remain part of the local image name, pull using the full path:

```bash
docker pull localhost:5000/library/nginx:latest
```

The result will be:

```text
REPOSITORY                    TAG
localhost:5000/library/nginx latest
```

The registry cannot remove or modify this path after the image has been pulled because Docker derives the local repository name from the pull reference.

## Cache

The proxy supports local caching for manifests and blobs.

By default:

```env
CACHE_DIR=./data/cache
CACHE_TTL_SECONDS=3600
```

Tags remain fresh for one hour.

To make the cache permanent:

```env
CACHE_TTL_SECONDS=0
```

Cached data is stored under:

```text
./data/cache
```

## Production Deployment

Docker generally requires HTTPS when communicating with remote registries.

For production deployments, place the proxy behind a reverse proxy such as:

* Nginx
* Caddy
* Traefik

and configure TLS.

Once deployed, you can pull images using your registry domain:

```bash
docker pull registry.example.com/docker.io/library/nginx:latest
```

## Local HTTP with Docker Desktop

When running the proxy directly with:

```bash
npm start
```

the Docker daemon may not be able to access the service through `localhost`.

You can instead run the proxy using:

```bash
docker compose up --build
```

Alternatively, you can configure Docker Desktop to allow an insecure registry such as:

```text
host.docker.internal:5000
```

For a custom domain or IP address served over HTTP, the address must also be configured as an `insecure-registries` entry in the Docker daemon configuration.

> **Note:** Insecure registries should generally only be used for local development or trusted private networks. Production registries should use HTTPS.

## License

Add your project license here.

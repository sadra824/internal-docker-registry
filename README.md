# Docker Save Registry Proxy

یک proxy سازگار با Docker Registry v2 که ایمیج را از خروجی `docker save` سرویس زیر می‌گیرد، manifest و blobهای قابل pull می‌سازد و به Docker client تحویل می‌دهد:

```bash
wget -q -O - "https://dockerimagesave.akiel.dev/image?name=<image-registry>/<image-repository>/<image-name>:tag"
```

## اجرا

```bash
npm install
npm start
```

اگر Docker Desktop استفاده می‌کنید، proxy را داخل Docker بالا بیاورید تا `localhost:5000` از دید Docker daemon هم به همین registry برسد:

```bash
docker compose up --build
```

تنظیمات پیش‌فرض داخل `.env` قرار دارد:

```env
APP_URL=localhost
APP_PORT=5000
HOST=::
DEFAULT_REGISTRY=docker.io
LOG_LEVEL=debug
UPSTREAM_TIMEOUT_MS=120000
```

پیش‌فرض روی پورت `5000` بالا می‌آید:

```bash
docker pull localhost:5000/library/nginx:latest
```

برای official imageهای Docker Hub می‌توانید کوتاه‌تر هم pull بزنید:

```bash
docker pull localhost:5000/nginx:latest
```

در این حالت ایمیج local دقیقا با همان reference دستور pull دیده می‌شود:

```bash
docker images
# localhost:5000/nginx   latest
```

## نام تمیزتر در docker images

Docker نام ایمیج local را از خود دستور `docker pull` می‌سازد و registry نمی‌تواند بخشی از path را بعد از pull حذف کند. اگر می‌خواهید خروجی به شکل زیر باشد:

```bash
docker images
# localhost:5000/library/nginx   latest
```

اپ را با registry پیش‌فرض اجرا کنید و موقع pull دیگر `docker.io` را در path نگذارید:

```bash
docker pull localhost:5000/library/nginx:latest
```

اپ در پشت صحنه همچنان این آدرس را از سرویس upstream می‌گیرد:

```text
https://dockerimagesave.akiel.dev/image?name=docker.io/library/nginx:latest
```

## تنظیمات

| Env | Default | توضیح |
| --- | --- | --- |
| `APP_URL` | `localhost` | host یا domain public اپ، بدون port |
| `APP_PORT` | `5000` | پورت HTTP. اگر نبود، `PORT` خوانده می‌شود |
| `PORT` | `5000` | fallback پورت HTTP |
| `HOST` | `::` در `.env` | آدرس listen. برای `localhost` بهتر است IPv6 هم فعال باشد |
| `CACHE_DIR` | `./data/cache` | محل cache blob و manifest |
| `SAVE_IMAGE_URL` | `https://dockerimagesave.akiel.dev/image` | سرویس تولید docker save tar |
| `CACHE_TTL_SECONDS` | `3600` | مدت fresh بودن tagها. مقدار `0` یعنی cache دائمی |
| `DEFAULT_REGISTRY` | `docker.io` در `.env` | registry پیش‌فرض برای pullهای کوتاه‌تر مثل `localhost:5000/library/nginx:latest` |
| `LOG_LEVEL` | `debug` در `.env` | سطح لاگ: `debug`, `info`, `warn`, `error` |
| `UPSTREAM_TIMEOUT_MS` | `120000` | timeout درخواست به سرویس `dockerimagesave.akiel.dev` |

## Deploy پشت HTTPS

Docker برای registryهای remote معمولا HTTPS می‌خواهد. برای production اپ را پشت Nginx/Caddy/Traefik با TLS قرار بدهید و بعد pull بزنید:

```bash
docker pull registry.example.com/docker.io/library/nginx:latest
```

برای تست local با HTTP روی Docker Desktop، اجرای مستقیم با `npm start` ممکن است از دید Docker daemon پشت `localhost` دیده نشود. در این حالت یا از `docker compose up --build` استفاده کنید، یا `host.docker.internal:5000` را به `insecure-registries` Docker اضافه کنید. برای دامنه یا IP بدون HTTPS باید آن را در Docker daemon به عنوان `insecure-registries` تنظیم کنید.

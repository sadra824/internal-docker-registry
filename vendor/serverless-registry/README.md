# serverless-registry (vendored)

این پوشه حاوی کد پروژه‌ی رسمی [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry)
است که به‌عنوان بک‌اند Docker Registry API (`/v2/…`) این ریپو استفاده می‌شود.

- **مجوز:** Apache License 2.0 — فایل [LICENSE](./LICENSE) مربوط به پروژه‌ی بالادستی است.
- **نسخه:** main @ a73605d (2026-08-17)
- تغییرات نسبت به بالادست:
  1. `src/registry/http.ts` (تابع `authenticate`): scope همیشه از خود namespace ساخته
     می‌شود، نه از چالشِ جانگهدارِ endpoint ریشه‌ی `/v2/` — بدون این پچ، fallback
     روی ghcr.io با DENIED شکست می‌خورد (scope دو بار wrap می‌شد).
  2. `src/registry/http.ts` (تابع `authenticateBearer`): scope توکن فقط `pull`
     است (به‌جای `pull,push`) — سرورهای توکن ناشناس (ghcr ،gcr و…) درخواستِ
     push را کامل رد می‌کنند و این پراکسی هرگز push به بالادست ندارد.
- وابستگی‌ها در `package.json` ریشه نصب می‌شوند: itty-router ،zod ،rfc4648 ،@tsndr/cloudflare-worker-jwt

نحوه‌ی استفاده در این پروژه: `src/index.js` درخواست‌های `/v2/*` را به
`index.ts` همین پوشه واگذار می‌کند (با binding ر2 به نام `REGISTRY`).

پیکربندی fallback از متغیر محیطی `REGISTRIES_JSON` (فرمت خود پروژه‌ی بالادستی)
خوانده می‌شود:
`[{"registry":"https://index.docker.io/"}]`

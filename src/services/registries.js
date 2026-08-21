/**
 * فهرست رجیستری‌های بالادستی — همان ترتیب registries.json نسخه قبل.
 * روی Worker فایل‌ها قابل خواندن نیستند؛ لیست پیش‌فرض داخل کد است و
 * با متغیر محیطی REGISTRIES_JSON (آرایه JSON) قابل بازنویسی است.
 */

const DEFAULT_REGISTRIES = [
    'docker.arvancloud.ir',
    'docker.io',
    'ghcr.io',
    'registry.k8s.io',
    'quay.io',
    'gcr.io',
    'public.ecr.aws',
    'mcr.microsoft.com',
    'registry.gitlab.com',
    'nvcr.io',
    'registry.hub.docker.com',
    'icr.io',
    'registry.cn-hangzhou.aliyuncs.com'
];

export function getRegistries(env = {}) {
    const raw = env.REGISTRIES_JSON;

    if (!raw) {
        return DEFAULT_REGISTRIES.slice();
    }

    let list;
    try {
        list = JSON.parse(raw);
    } catch (err) {
        throw new Error(`فرمت REGISTRIES_JSON نامعتبر است: ${err.message}`);
    }

    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('REGISTRIES_JSON باید یک آرایه غیرخالی از رشته (نام هاست رجیستری) باشد');
    }

    return list;
}

/**
 * فهرست رجیستری‌های بالادستی برای مسیر دانلود مستقیم (/image).
 *
 * نکته: متغیر REGISTRIES_JSON مال بک‌اند serverless-registry است (فرمت
 * خودش: آرایه‌ی {registry, username, password_env})؛ این‌جا برای جلوگیری از
 * تداخل، از PASSTHROUGH_REGISTRIES_JSON استفاده می‌کنیم — آرایه‌ی ساده‌ی
 * نام هاست‌ها، به‌همراه سرویس منبع.
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
    const raw = env.PASSTHROUGH_REGISTRIES_JSON;

    if (!raw) {
        return DEFAULT_REGISTRIES.slice();
    }

    let list;
    try {
        list = JSON.parse(raw);
    } catch (err) {
        throw new Error(`فرمت PASSTHROUGH_REGISTRIES_JSON نامعتبر است: ${err.message}`);
    }

    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('PASSTHROUGH_REGISTRIES_JSON باید یک آرایه غیرخالی از رشته (نام هاست رجیستری) باشد');
    }

    return list;
}

'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const Store = require('./lib/store');
const buildV2Router = require('./routes/v2');

const PORT = process.env.PORT || 5000;

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');

function parseBoolean(value, defaultValue = true) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    return String(value).toLowerCase() === 'true';
}

function parseSize(value, defaultValue = 0) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value)
        .trim()
        .toUpperCase();

    const match = normalized.match(
        /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/
    );

    if (!match) {
        throw new Error(
            `CACHE_MAX_SIZE نامعتبر است: "${value}". ` +
            `مثال معتبر: 500MB، 10GB، 1TB`
        );
    }

    const number = Number(match[1]);
    const unit = match[2] || 'B';

    const multipliers = {
        B: 1,
        KB: 1024,
        MB: 1024 ** 2,
        GB: 1024 ** 3,
        TB: 1024 ** 4
    };

    return Math.floor(number * multipliers[unit]);
}

function parseInterval(value, defaultValue = 3600000) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value)
        .trim()
        .toLowerCase();

    // مقدار خام بر حسب millisecond
    if (/^\d+$/.test(normalized)) {
        return Number(normalized);
    }

    const match = normalized.match(
        /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/
    );

    if (!match) {
        throw new Error(
            `CACHE_CLEANUP_INTERVAL نامعتبر است: "${value}". ` +
            `مثال معتبر: 30m، 1h، 6h، 1d`
        );
    }

    const number = Number(match[1]);
    const unit = match[2];

    const multipliers = {
        ms: 1,
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000
    };

    return Math.floor(number * multipliers[unit]);
}

const CACHE_ENABLED = parseBoolean(
    process.env.CACHE_ENABLED,
    true
);

const CACHE_MAX_SIZE = parseSize(
    process.env.CACHE_MAX_SIZE,
    0
);

const CACHE_CLEANUP_INTERVAL = parseInterval(
    process.env.CACHE_CLEANUP_INTERVAL,
    60 * 60 * 1000
);

const store = new Store(DATA_DIR, {
    cacheEnabled: CACHE_ENABLED,
    maxSizeBytes: CACHE_MAX_SIZE
});

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
    console.log(
        `${new Date().toISOString()} ${req.method} ${req.originalUrl}`
    );

    next();
});

// لندینگ پیج (توضیح نحوه کار پروژه) از ریشه سرو می‌شود
app.use(
    express.static(
        path.join(__dirname, '..', 'public'),
        { fallthrough: true }
    )
);

app.use(
    '/v2',
    buildV2Router(store, {
        cacheEnabled: CACHE_ENABLED,
        maxSizeBytes: CACHE_MAX_SIZE
    })
);

app.use((req, res) => {
    res.status(404).json({
        errors: [
            {
                code: 'NOT_FOUND',
                message: 'مسیر یافت نشد'
            }
        ]
    });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('خطای پیش‌بینی‌نشده:', err);

    res.status(500).json({
        errors: [
            {
                code: 'INTERNAL_ERROR',
                message: 'خطای داخلی سرور'
            }
        ]
    });
});

app.listen(PORT, () => {
    console.log(
        `Docker Registry proxy روی پورت ${PORT} در حال اجراست`
    );

    console.log(`داده‌ها در مسیر ${DATA_DIR} ذخیره می‌شوند`);

    console.log(
        `CACHE_ENABLED=${CACHE_ENABLED}`
    );

    console.log(
        `CACHE_MAX_SIZE=${CACHE_MAX_SIZE} bytes`
    );

    console.log(
        `CACHE_CLEANUP_INTERVAL=${CACHE_CLEANUP_INTERVAL} ms`
    );

    if (CACHE_ENABLED && CACHE_MAX_SIZE > 0) {
        console.log('[cache] محدودیت حجم cache فعال است');

        // یک بار هنگام startup
        store.cleanup(CACHE_MAX_SIZE);

        // cleanup دوره‌ای
        setInterval(() => {
            try {
                store.cleanup(CACHE_MAX_SIZE);
            } catch (err) {
                console.error(
                    '[cache] خطا در cleanup:',
                    err
                );
            }
        }, CACHE_CLEANUP_INTERVAL);
    } else if (!CACHE_ENABLED) {
        console.log(
            '[cache] persistent cache غیرفعال است'
        );
    } else {
        console.log(
            '[cache] محدودیت حجم cache تنظیم نشده است'
        );
    }
});
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

const store = new Store(DATA_DIR);
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    next();
});

app.use('/v2', buildV2Router(store));

app.use((req, res) => {
    res.status(404).json({
        errors: [{ code: 'NOT_FOUND', message: 'مسیر یافت نشد' }]
    });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('خطای پیش‌بینی‌نشده:', err);
    res.status(500).json({
        errors: [{ code: 'INTERNAL_ERROR', message: 'خطای داخلی سرور' }]
    });
});

app.listen(PORT, () => {
    console.log(`Docker Registry proxy روی پورت ${PORT} در حال اجراست`);
    console.log(`داده‌ها در مسیر ${DATA_DIR} کش می‌شوند`);
});
'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRIES_FILE = process.env.REGISTRIES_FILE
    ? path.resolve(process.env.REGISTRIES_FILE)
    : path.join(__dirname, '..', '..', 'registries.json');

function getRegistries() {
    let raw;
    try {
        raw = fs.readFileSync(REGISTRIES_FILE, 'utf8');
    } catch (err) {
        throw new Error(`فایل registries.json پیدا نشد (${REGISTRIES_FILE}): ${err.message}`);
    }

    let list;
    try {
        list = JSON.parse(raw);
    } catch (err) {
        throw new Error(`فرمت registries.json نامعتبر است: ${err.message}`);
    }

    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('registries.json باید یک آرایه غیرخالی از رشته (نام هاست رجیستری) باشد');
    }

    return list;
}

module.exports = { getRegistries, REGISTRIES_FILE };
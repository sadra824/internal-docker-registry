/**
 * لاگر سبک و ساختاریافته — خروجی در `wrangler tail` قابل خواندن.
 *
 * فرمت هر خط:  <ISO time> <LEVEL> [component] message {data}
 *
 * سطح لاگ با متغیر محیطی LOG_LEVEL قابل تنظیم است:
 *   debug | info | warn | error   (پیش‌فرض: info)
 */

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const CONSOLE_FN = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };

let minLevel = LEVELS.info;

/**
 * @param {'debug'|'info'|'warn'|'error'} name
 */
export function setLogLevel(name) {
    const level = LEVELS[String(name).toLowerCase()];
    if (level !== undefined) {
        minLevel = level;
    }
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function emit(level, component, message, data) {
    if (LEVELS[level] < minLevel) {
        return;
    }

    const now = new Date();
    const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`
        + `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;

    const extra = data && Object.keys(data).length > 0
        ? ` ${JSON.stringify(data)}`
        : '';

    console[CONSOLE_FN[level]](`${ts} ${level.toUpperCase()} [${component}] ${message}${extra}`);
}

/**
 * سازنده‌ی لاگر با component ثابت:
 *   const info = logger('registry').info;
 *   info('manifest miss', { name });
 */
export function logger(component) {
    return {
        debug: (message, data) => emit('debug', component, message, data),
        info: (message, data) => emit('info', component, message, data),
        warn: (message, data) => emit('warn', component, message, data),
        error: (message, data) => emit('error', component, message, data)
    };
}

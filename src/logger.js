'use strict';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function createLogger(options = {}) {
  const configuredLevel = String(options.level || 'info').toLowerCase();
  const minLevel = LEVELS[configuredLevel] || LEVELS.info;

  function write(level, message, fields = {}) {
    if ((LEVELS[level] || LEVELS.info) < minLevel) return;

    const line = {
      time: new Date().toISOString(),
      level,
      message,
      ...serializeFields(fields)
    };

    const output = JSON.stringify(line);
    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields)
  };
}

function serializeFields(fields) {
  const serialized = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value instanceof Error) {
      serialized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    } else {
      serialized[key] = value;
    }
  }
  return serialized;
}

module.exports = {
  createLogger
};

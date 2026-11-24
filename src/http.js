'use strict';

const UA = 'Mozilla/5.0 (bom-nowcast-js)';
const DEFAULT_TIMEOUT_MS = 12000;

async function fetchBuffer(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? 1;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = new Error(`GET ${url} -> ${res.status}`);
        err.status = res.status;
        // Do not retry 4xx client errors.
        if (res.status >= 400 && res.status < 500) throw err;
        lastErr = err;
        continue;
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      if (err && err.status >= 400 && err.status < 500) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchText(url, opts = {}) {
  const buf = await fetchBuffer(url, opts);
  return buf.toString('utf8');
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (nextIdx < items.length) {
        const idx = nextIdx++;
        results[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

module.exports = {
  UA,
  fetchBuffer,
  fetchText,
  mapConcurrent,
};

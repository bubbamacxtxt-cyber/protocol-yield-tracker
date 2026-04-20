/**
 * Shared fetch helper with retry, timeout, and error handling.
 * Usage: const { fetchWithRetry } = require('./fetch-helper');
 */

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF = 2000; // ms

async function fetchWithRetry(url, options = {}, retries = DEFAULT_RETRIES) {
  const { timeout = DEFAULT_TIMEOUT, backoff = DEFAULT_BACKOFF, ...fetchOptions } = options;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      
      const res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      clearTimeout(timer);
      
      // Retry on 429 (rate limit) or 5xx
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : backoff * attempt;
        if (attempt < retries) {
          console.warn(`  [fetch] ${res.status} ${url.slice(0,60)}... retry in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      
      return res;
    } catch (err) {
      if (attempt === retries) {
        console.error(`  [fetch] FAILED after ${retries} attempts: ${url.slice(0,60)}... (${err.message})`);
        return null;
      }
      console.warn(`  [fetch] attempt ${attempt}/${retries} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, backoff * attempt));
    }
  }
  return null;
}

async function fetchJSON(url, options = {}, retries = DEFAULT_RETRIES) {
  const res = await fetchWithRetry(url, options, retries);
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

module.exports = { fetchWithRetry, fetchJSON };

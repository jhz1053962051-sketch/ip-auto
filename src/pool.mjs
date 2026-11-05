/**
 * 极简并发池：限制同时进行的任务数，返回与输入同序的结果。
 */
export async function mapPool(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { error: e?.message || String(e) };
      }
      done++;
      onProgress?.(done, items.length, results[i], items[i]);
    }
  });

  await Promise.all(workers);
  return results;
}

/** 简单重试 */
export async function withRetry(fn, { attempts = 2, delayMs = 400 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

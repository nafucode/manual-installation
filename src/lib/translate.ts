/**
 * 免费翻译服务：基于 MyMemory API
 * - 无需 API Key
 * - 匿名限额 ~5000 字符/天/IP
 * - 支持所有主流语种（fr/es/ru/ar/vi 等）
 *
 * 结果自动缓存到 localStorage，同一段文字翻译过之后不再重复请求。
 */

export type TargetLang = "fr" | "es" | "ru" | "ar" | "vi" | "zh" | "en";

const CACHE_KEY = "doc_extractor_translation_cache_v1";
/** 单次请求文本上限，超过要拆句 */
const MAX_CHUNK = 480;

type Cache = Record<string, string>;

function loadCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cache: Cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore quota
  }
}

/** 简易 hash（djb2）用于缓存 key */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 按句号/问号/感叹号切分成不超过 MAX_CHUNK 的片段 */
function splitChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  const sentences = text.split(/([.!?。！？]\s*)/);
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > MAX_CHUNK && buf) {
      parts.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) parts.push(buf);
  // 万一还有超长片段（无标点），硬切
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= MAX_CHUNK) {
      out.push(p);
    } else {
      for (let i = 0; i < p.length; i += MAX_CHUNK) {
        out.push(p.slice(i, i + MAX_CHUNK));
      }
    }
  }
  return out;
}

async function fetchMyMemory(
  text: string,
  from: string,
  to: string,
): Promise<string> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    text,
  )}&langpair=${from}|${to}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`translate http ${resp.status}`);
  const data = await resp.json();
  const translated = data?.responseData?.translatedText as string | undefined;
  if (!translated) throw new Error("empty translation");
  // MyMemory 有时会返回全大写的错误信息（如 QUOTA / MYMEMORY WARNING）
  if (
    /^(MYMEMORY|QUERY LENGTH|QUOTA|INVALID|LIMIT)/i.test(translated) &&
    translated.length < 200
  ) {
    throw new Error(translated);
  }
  return translated;
}

/**
 * 翻译一段文字。缓存命中直接返回；否则拆句并发请求（并发 3）。
 * from = "en" | "zh"，to 为目标语言。
 */
export async function translateText(
  text: string,
  from: "en" | "zh",
  to: TargetLang,
): Promise<string> {
  if (!text.trim()) return "";
  if (from === to) return text;

  const cache = loadCache();
  const key = `${from}:${to}:${hash(text)}`;
  if (cache[key]) return cache[key];

  const chunks = splitChunks(text);
  const results: string[] = new Array(chunks.length);

  // 并发 3
  let idx = 0;
  const concurrency = 3;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < chunks.length) {
      const i = idx++;
      results[i] = await fetchMyMemory(chunks[i], from, to);
    }
  });
  await Promise.all(workers);

  const merged = results.join(" ");
  cache[key] = merged;
  saveCache(cache);
  return merged;
}

/** 只查缓存，不发请求 */
export function getCachedTranslation(
  text: string,
  from: "en" | "zh",
  to: TargetLang,
): string | null {
  if (!text.trim()) return "";
  if (from === to) return text;
  const cache = loadCache();
  const key = `${from}:${to}:${hash(text)}`;
  return cache[key] ?? null;
}

/** 手动写入一条翻译到缓存（用于「翻译工作包」回填） */
export function saveTranslation(
  text: string,
  from: "en" | "zh",
  to: TargetLang,
  translated: string,
) {
  if (!text.trim() || !translated.trim()) return;
  const cache = loadCache();
  const key = `${from}:${to}:${hash(text)}`;
  cache[key] = translated;
  saveCache(cache);
}

/** 清除全部翻译缓存 */
export function clearTranslationCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

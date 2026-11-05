// Shared Arabic search normalizer for the browser and the local server.
// Handles common Iraqi/Arabic orthographic variants; does not alter stored names.
// This is deliberately deterministic: no remote AI service or paid API.
const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const DIGITS = '0123456789';
export function normalizeArabicSearch(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ar')
    .replace(DIACRITICS, '')
    .replace(INVISIBLE, '')
    .replace(/\u0640/g, '')
    .replace(/[أإآٱٲٳٵ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ىیۍ]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[کڪ]/g, 'ك')
    .replace(/[٠-٩۰-۹]/g, (ch) => DIGITS[(ch.codePointAt(0) <= 0x0669 ? ch.codePointAt(0) - 0x0660 : ch.codePointAt(0) - 0x06F0)])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().replace(/\s+/g, ' ');
}

// Split the query into independent words: "ورقي اقداح" finds "أقداح ورقية".
export function matchesArabicSearch(query, ...fields) {
  const terms = normalizeArabicSearch(query).split(' ').filter(Boolean);
  if (!terms.length) return true;
  const haystack = normalizeArabicSearch(fields.filter((v) => v != null).join(' '));
  return terms.every(term => haystack.includes(term));
}

export function filterArabicProducts(products, query, limit = Infinity) {
  const terms = normalizeArabicSearch(query).split(' ').filter(Boolean);
  if (!terms.length) return products.slice(0, limit);
  const matches = [];
  for (const product of products) {
    if (matchesArabicSearch(query, product.name, product.description, product.manufacture)) {
      matches.push(product);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

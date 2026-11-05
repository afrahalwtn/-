export function normalizeArabicSearch(input: unknown): string;
export function matchesArabicSearch(query: unknown, ...fields: unknown[]): boolean;
export function filterArabicProducts<T extends { name: string; description?: string; manufacture?: string }>(products: T[], query: string, limit?: number): T[];

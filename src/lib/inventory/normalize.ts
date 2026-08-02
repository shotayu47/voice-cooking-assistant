/**
 * Ingredient name normalization (SPEC §14).
 *
 * Matching is deterministic and conservative. The rule that matters:
 * "Do not automatically merge genuinely different ingredients." So a lookup
 * either resolves to exactly one item or reports ambiguity — it never guesses.
 */

import type { InventoryItem } from '@/types/domain';

/**
 * Aliases map a spoken/written variant onto a canonical ingredient name.
 * Kept small and hand-curated on purpose: a wrong entry here silently
 * rewrites the user's inventory.
 */
export const INGREDIENT_ALIASES: Record<string, string> = {
  // 鶏
  鶏もも: '鶏もも肉',
  鳥もも: '鶏もも肉',
  とりもも: '鶏もも肉',
  鶏むね: '鶏むね肉',
  鳥むね: '鶏むね肉',
  鶏胸肉: '鶏むね肉',
  鶏胸: '鶏むね肉',
  チキン: '鶏肉',
  とり肉: '鶏肉',
  鳥肉: '鶏肉',
  // 豚 / 牛
  ポーク: '豚肉',
  ぶた肉: '豚肉',
  ビーフ: '牛肉',
  ぎゅう肉: '牛肉',
  挽肉: 'ひき肉',
  ミンチ: 'ひき肉',
  // 野菜
  たまねぎ: '玉ねぎ',
  タマネギ: '玉ねぎ',
  玉葱: '玉ねぎ',
  オニオン: '玉ねぎ',
  にんじん: '人参',
  ニンジン: '人参',
  キャロット: '人参',
  じゃがいも: 'じゃが芋',
  ジャガイモ: 'じゃが芋',
  馬鈴薯: 'じゃが芋',
  ポテト: 'じゃが芋',
  ニンニク: 'にんにく',
  大蒜: 'にんにく',
  ガーリック: 'にんにく',
  ショウガ: '生姜',
  しょうが: '生姜',
  ジンジャー: '生姜',
  ネギ: 'ねぎ',
  長ネギ: 'ねぎ',
  長ねぎ: 'ねぎ',
  キャベツ玉: 'キャベツ',
  トマト缶: 'カットトマト缶',
  // 卵 / 乳
  たまご: '卵',
  タマゴ: '卵',
  玉子: '卵',
  エッグ: '卵',
  ミルク: '牛乳',
  チーズ類: 'チーズ',
  // 調味料
  しょうゆ: '醤油',
  ショウユ: '醤油',
  しょう油: '醤油',
  ソイソース: '醤油',
  みそ: '味噌',
  ミソ: '味噌',
  みりん: 'みりん',
  味醂: 'みりん',
  さとう: '砂糖',
  シュガー: '砂糖',
  しお: '塩',
  ソルト: '塩',
  こしょう: '胡椒',
  コショウ: '胡椒',
  ペッパー: '胡椒',
  酒: '料理酒',
  日本酒: '料理酒',
  ごま油: 'ゴマ油',
  サラダ油: '油',
  // English
  chickenthigh: '鶏もも肉',
  chickenbreast: '鶏むね肉',
  chicken: '鶏肉',
  pork: '豚肉',
  beef: '牛肉',
  onion: '玉ねぎ',
  carrot: '人参',
  potato: 'じゃが芋',
  garlic: 'にんにく',
  ginger: '生姜',
  egg: '卵',
  eggs: '卵',
  milk: '牛乳',
  soysauce: '醤油',
  salt: '塩',
  sugar: '砂糖',
  pepper: '胡椒',
};

const HIRAGANA_START = 0x3041;
const HIRAGANA_END = 0x3096;
const KATAKANA_OFFSET = 0x60;

function hiraganaToKatakana(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0)!;
    out +=
      code >= HIRAGANA_START && code <= HIRAGANA_END
        ? String.fromCodePoint(code + KATAKANA_OFFSET)
        : char;
  }
  return out;
}

/**
 * Fold a raw name into a comparable key: NFKC (full-width → half-width,
 * half-width katakana → full-width), lowercase, whitespace and common
 * separators removed, hiragana folded to katakana.
 */
export function foldName(raw: string): string {
  const folded = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　_/·・、,.-]/g, '');
  return hiraganaToKatakana(folded);
}

/**
 * Canonical name for an ingredient: the alias target if one exists, otherwise
 * the trimmed original. This is what gets written to `normalized_name`.
 */
export function normalizeIngredientName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const key = foldName(trimmed);

  // Direct alias hit.
  for (const [alias, canonical] of Object.entries(INGREDIENT_ALIASES)) {
    if (foldName(alias) === key) return canonical;
  }

  return trimmed.normalize('NFKC');
}

export type ResolveResult =
  | { status: 'matched'; item: InventoryItem }
  | { status: 'ambiguous'; candidates: InventoryItem[] }
  | { status: 'not_found'; candidates: [] };

/**
 * Resolve a user-spoken ingredient name against the inventory.
 *
 * Tiers, most confident first. Each tier only resolves when it yields exactly
 * one item; more than one means ambiguous, and an ambiguous result must never
 * be mutated destructively (SPEC §11.2 「在庫更新」).
 */
export function resolveInventoryItem(
  query: string,
  items: InventoryItem[],
): ResolveResult {
  const trimmed = query.trim();
  if (!trimmed || items.length === 0) {
    return { status: 'not_found', candidates: [] };
  }

  const queryKey = foldName(trimmed);
  const canonicalKey = foldName(normalizeIngredientName(trimmed));

  const keysFor = (item: InventoryItem) => {
    const keys = [foldName(item.name)];
    if (item.normalized_name) keys.push(foldName(item.normalized_name));
    keys.push(foldName(normalizeIngredientName(item.name)));
    return keys;
  };

  // Tier 1 — exact match on the raw or stored normalized name.
  const exact = items.filter((item) => keysFor(item).includes(queryKey));
  if (exact.length === 1) return { status: 'matched', item: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact };

  // Tier 2 — both sides resolved through the alias dictionary.
  const viaAlias = items.filter((item) => keysFor(item).includes(canonicalKey));
  if (viaAlias.length === 1) return { status: 'matched', item: viaAlias[0] };
  if (viaAlias.length > 1) return { status: 'ambiguous', candidates: viaAlias };

  // Tier 3 — containment ("鶏もも" → "鶏もも肉"). Only when unique.
  const contains = items.filter((item) =>
    keysFor(item).some(
      (key) => key.includes(canonicalKey) || canonicalKey.includes(key),
    ),
  );
  if (contains.length === 1) return { status: 'matched', item: contains[0] };
  if (contains.length > 1) return { status: 'ambiguous', candidates: contains };

  return { status: 'not_found', candidates: [] };
}

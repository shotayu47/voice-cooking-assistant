/**
 * Which suggestion card is "the same card" after a recipe is revised?
 *
 * `call_id` cannot answer that. It is fresh on every tool call, so a revised
 * recipe's candidates arrived as a second card while the first — built from
 * the ingredients the user had just asked to replace — stayed on screen
 * beside it. Both looked current.
 *
 * A revision creates a new recipe row rather than editing one, so the two
 * versions have different ids and nothing in the candidates links them. What
 * links them is `supersedes_recipe_id`, reported by `revise_recipe`. Following
 * that chain back gives a stable identity for a recipe across its revisions,
 * and that is what a card is keyed by.
 *
 * `call_id` still guards tool execution — one relay, one run. This is only
 * about which card on screen a new result replaces.
 */

/** new recipe id → the recipe it was revised from. */
export type RevisionChain = ReadonlyMap<string, string>;

/**
 * The original a recipe descends from.
 *
 * Guarded against a cycle: a malformed chain should give a stable answer
 * rather than hang, and the id it started from is as good as any.
 */
export function lineageRoot(recipeId: string, chain: RevisionChain): string {
  const seen = new Set<string>([recipeId]);
  let current = recipeId;

  for (;;) {
    const parent = chain.get(current);
    if (!parent || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

/**
 * A key identifying the dish or dishes a set of candidates is about.
 *
 * Sorted, so the same recipes in a different order are the same card, and
 * joined so a request covering two dishes stays distinct from either alone.
 */
export function lineageKeyOf(recipeIds: readonly string[], chain: RevisionChain): string {
  const roots = [...new Set(recipeIds.map((id) => lineageRoot(id, chain)))].sort();
  return roots.join('+');
}

/** The recipes a set of candidates came from, in the order first seen. */
export function recipeIdsOf(
  suggestions: readonly { sourceRecipes?: readonly { recipeId: string }[] }[],
): string[] {
  const ids: string[] = [];
  for (const suggestion of suggestions) {
    for (const source of suggestion.sourceRecipes ?? []) {
      if (!ids.includes(source.recipeId)) ids.push(source.recipeId);
    }
  }
  return ids;
}

/**
 * Shown above a card that replaced one built from an earlier version.
 *
 * Says what happened to the old candidates, and — because nothing is ever
 * removed from the shopping list on the user's behalf — that anything already
 * added is still there.
 */
export const REVISED_CARD_NOTICE =
  'レシピを変更したため、買い物候補を更新しました。すでに追加済みの項目は買い物リストに残ります。';

/** One recipe replacing another, as `revise_recipe` reports it. */
export type RevisionEdge = {
  recipeId: string;
  supersedesRecipeId: string;
};

/** The chain a conversation starts with. Never mutated, so it can be shared. */
export const NO_REVISIONS: RevisionChain = new Map();

/**
 * Add one revision to the chain, without touching the chain given.
 *
 * The chain used to be rebuilt every turn, which quietly capped it at one
 * link: a second revision in a later turn knew only that R3 came from R2, so
 * its card keyed on R2 while the card already on screen keyed on R1, and the
 * two sat side by side — the stale one still showing the candidates for the
 * version the user had just replaced. Accumulating instead is what lets
 * `lineageRoot` walk R4 → R3 → R2 → R1 however many revisions it takes.
 *
 * Idempotent: re-applying an edge a replay or a re-read reports again returns
 * a chain that says the same thing. A self-referential edge is not special
 * cased — `lineageRoot` already stops on a cycle, and inventing a rule here
 * that the tool result cannot produce would be guessing.
 */
export function withRevisionEdge(
  chain: RevisionChain,
  edge: RevisionEdge | null | undefined,
): RevisionChain {
  if (!edge) return chain;

  const { recipeId, supersedesRecipeId } = edge;
  if (!recipeId || !supersedesRecipeId) return chain;
  if (chain.get(recipeId) === supersedesRecipeId) return chain;

  const next = new Map(chain);
  next.set(recipeId, supersedesRecipeId);
  return next;
}

/**
 * The revision a tool result reports, or null.
 *
 * Read from the structured result, never from what the assistant said. A
 * failed `revise_recipe` returns an error and carries neither id, so nothing
 * is recorded for it — the recipe it would have replaced is still current.
 */
export function revisionEdgeOf(result: unknown): RevisionEdge | null {
  if (!result || typeof result !== 'object') return null;

  const { recipe_id: recipeId, supersedes_recipe_id: supersedesRecipeId } = result as {
    recipe_id?: unknown;
    supersedes_recipe_id?: unknown;
  };

  return typeof recipeId === 'string' && typeof supersedesRecipeId === 'string'
    ? { recipeId, supersedesRecipeId }
    : null;
}

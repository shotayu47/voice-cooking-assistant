import 'server-only';

import type { Recipe, StoredRecipe } from '@/types/domain';
import { ServiceError, type ServiceContext } from '@/lib/inventory/service';
import { normalizeStepIndices, recipeSchema } from './schemas';

const RECIPE_COLUMNS =
  'id, user_id, title, description, servings, estimated_minutes, difficulty, ingredients, steps, source_type, created_at';

type RecipeRow = {
  id: string;
  user_id: string | null;
  title: string;
  description: string | null;
  servings: number | null;
  estimated_minutes: number | null;
  difficulty: string | null;
  ingredients: unknown;
  steps: unknown;
  source_type: string;
  created_at: string;
};

function toStoredRecipe(row: RecipeRow): StoredRecipe {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    description: row.description ?? undefined,
    servings: row.servings ?? 1,
    estimatedMinutes: row.estimated_minutes ?? undefined,
    difficulty: (row.difficulty as StoredRecipe['difficulty']) ?? undefined,
    ingredients: (row.ingredients ?? []) as StoredRecipe['ingredients'],
    steps: (row.steps ?? []) as StoredRecipe['steps'],
    source_type: row.source_type as StoredRecipe['source_type'],
    created_at: row.created_at,
  };
}

export async function createRecipe(
  ctx: ServiceContext,
  input: unknown,
  sourceType: 'ai' | 'user' = 'ai',
): Promise<StoredRecipe> {
  const parsed = normalizeStepIndices(recipeSchema.parse(input));

  const { data, error } = await ctx.supabase
    .from('recipes')
    .insert({
      user_id: ctx.userId,
      title: parsed.title,
      description: parsed.description ?? null,
      servings: parsed.servings,
      estimated_minutes: parsed.estimatedMinutes ?? null,
      difficulty: parsed.difficulty ?? null,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      source_type: sourceType,
    })
    .select(RECIPE_COLUMNS)
    .single();

  if (error) throw new ServiceError(error.message);
  return toStoredRecipe(data as RecipeRow);
}

/** What a revision produced, and what it was derived from. */
export type RevisedRecipe = {
  recipe: StoredRecipe;
  supersedesRecipeId: string;
};

/**
 * Saves a changed version of an existing recipe as a *new* row.
 *
 * Nothing is updated in place. "顆粒だしではなく出汁から" is a different recipe,
 * and overwriting the original would erase what the user cooked yesterday —
 * while leaving `cooking_sessions.recipe_id` pointing at a row whose contents
 * had silently changed underneath it.
 *
 * A session is unaffected either way: it holds `recipe_snapshot`, which is the
 * authority for what is being cooked right now. So a revision mid-cook cannot
 * reorder the steps under someone's hands.
 *
 * The source is read through `getRecipe`, which scopes to `ctx.userId` — so a
 * recipe belonging to someone else is simply not found, and nothing is
 * written. Validation runs before the insert, so a malformed revision leaves
 * no row behind either.
 */
export async function reviseRecipe(
  ctx: ServiceContext,
  sourceRecipeId: string,
  input: unknown,
): Promise<RevisedRecipe> {
  const source = await getRecipe(ctx, sourceRecipeId);
  if (!source) throw new ServiceError('元のレシピが見つかりません');

  // Same schema as creating one: a revision is a whole recipe, not a patch.
  // Validating first is what keeps a rejected revision from writing a row.
  const recipe = await createRecipe(ctx, input, 'ai');

  return { recipe, supersedesRecipeId: source.id };
}

export async function getRecipe(
  ctx: ServiceContext,
  id: string,
): Promise<StoredRecipe | null> {
  const { data, error } = await ctx.supabase
    .from('recipes')
    .select(RECIPE_COLUMNS)
    .eq('user_id', ctx.userId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new ServiceError(error.message);
  return data ? toStoredRecipe(data as RecipeRow) : null;
}

export async function listRecipes(ctx: ServiceContext, limit = 20): Promise<StoredRecipe[]> {
  const { data, error } = await ctx.supabase
    .from('recipes')
    .select(RECIPE_COLUMNS)
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new ServiceError(error.message);
  return ((data ?? []) as RecipeRow[]).map(toStoredRecipe);
}

/** Strip DB-only fields so a recipe can be snapshotted into a session. */
export function toRecipeSnapshot(recipe: StoredRecipe): Recipe {
  return {
    title: recipe.title,
    description: recipe.description,
    servings: recipe.servings,
    estimatedMinutes: recipe.estimatedMinutes,
    difficulty: recipe.difficulty,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
  };
}

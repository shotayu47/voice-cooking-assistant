/**
 * Explicit domain types. These mirror the database schema (SPEC §6) and the
 * recipe format (SPEC §9). The database is the source of truth — these types
 * describe what comes out of it, never what the model claims.
 */

export const QUANTITY_STATES = [
  'unknown',
  'low',
  'available',
  'plenty',
  'empty',
] as const;
export type QuantityState = (typeof QUANTITY_STATES)[number];

export const STORAGE_LOCATIONS = [
  'fridge',
  'freezer',
  'pantry',
  'room_temperature',
  'other',
] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const CATEGORIES = [
  'meat',
  'fish',
  'vegetable',
  'egg_dairy',
  'frozen',
  'rice_noodle',
  'seasoning',
  'sauce',
  'oil',
  'spice',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const COOKING_SESSION_STATUSES = [
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;
export type CookingSessionStatus = (typeof COOKING_SESSION_STATUSES)[number];

export const TRANSACTION_ACTIONS = [
  'create',
  'increase',
  'decrease',
  'set_quantity',
  'set_state',
  'consume_all',
  'delete',
] as const;
export type TransactionAction = (typeof TRANSACTION_ACTIONS)[number];

export const TRANSACTION_SOURCES = [
  'manual',
  'ai_text',
  'ai_voice',
  'receipt',
  'barcode',
  'photo',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type Profile = {
  id: string;
  display_name: string | null;
  locale: string;
  timezone: string;
  cooking_skill_level: 'beginner' | 'intermediate' | 'advanced';
  preferred_heat_scale: 'ih_10' | 'low_medium_high';
  created_at: string;
  updated_at: string;
};

export type InventoryItem = {
  id: string;
  user_id: string;
  name: string;
  normalized_name: string | null;
  category: string | null;
  quantity: number | null;
  unit: string | null;
  quantity_state: QuantityState;
  storage_location: StorageLocation | null;
  expiry_date: string | null;
  opened: boolean | null;
  notes: string | null;
  created_at: string;
  updated_at: string;

  // PHASE 1 — expiry tracking (migration 0003). Optional so the code still
  // runs against a database where that migration has not been applied.
  purchased_at?: string | null;
  opened_at?: string | null;
  /** 消費期限 (use_by) vs 賞味期限 (best_before). */
  expiry_kind?: 'use_by' | 'best_before' | null;
  /** Whether `expiry_date` was given by the user or estimated by the app. */
  expiry_source?: 'user' | 'estimated' | 'unknown' | null;
};

/** SPEC §9 — recipe ingredient. */
export type RecipeIngredient = {
  inventoryItemId?: string;
  name: string;
  amount?: number;
  unit?: string;
  required: boolean;
  substituteOptions?: string[];
};

/** SPEC §9 — a single atomic cooking step. */
export type RecipeStep = {
  index: number;
  instruction: string;
  durationSeconds?: number;
  heat?: {
    type: 'ih_10' | 'low_medium_high';
    value?: number;
    label?: string;
  };
  ingredientRefs?: string[];
  safetyNote?: string;
};

export type Recipe = {
  title: string;
  description?: string;
  servings: number;
  estimatedMinutes?: number;
  difficulty?: Difficulty;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
};

export type StoredRecipe = Recipe & {
  id: string;
  user_id: string | null;
  source_type: 'ai' | 'user' | 'imported';
  created_at: string;
};

export type CookingSession = {
  id: string;
  user_id: string;
  recipe_id: string | null;
  recipe_snapshot: Recipe;
  current_step: number;
  total_steps: number;
  status: CookingSessionStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Set only by AI-initiated moves; drives the duplicate-relay guard. */
  last_ai_step_move_at?: string | null;

  // PHASE 5 — progress detail (migration 0004). Optional so the code still
  // runs against a database where that migration has not been applied.
  /** Step indices explicitly marked done. */
  completed_steps?: number[] | null;
  /** Step indices deliberately jumped over. */
  skipped_steps?: number[] | null;
  /** What this cook actually consumed. */
  used_ingredients?: UsedIngredient[] | null;
};

/** One ingredient consumed during a cook, recorded as inventory is decremented. */
export type UsedIngredient = {
  name: string;
  inventoryItemId: string | null;
  amount: number | null;
  unit: string | null;
  /** Which step was on screen at the time, when known. */
  stepIndex: number | null;
  recordedAt: string;
};

export type InventoryTransaction = {
  id: string;
  user_id: string;
  inventory_item_id: string | null;
  action: TransactionAction;
  quantity_delta: number | null;
  previous_value: unknown;
  new_value: unknown;
  source: TransactionSource;
  created_at: string;
};

export type ChatRole = 'user' | 'assistant' | 'tool';

export type ConversationMessage = {
  id: string;
  conversation_session_id: string;
  user_id: string;
  role: ChatRole;
  content: string | null;
  tool_calls: unknown;
  tool_call_id: string | null;
  created_at: string;
};

/** SPEC §5.5 — a meal proposal card. */
export type MealCandidate = {
  title: string;
  estimatedMinutes?: number;
  difficulty?: Difficulty;
  availableIngredients: string[];
  missingRequired: string[];
  missingOptional: string[];
  reason: string;
};

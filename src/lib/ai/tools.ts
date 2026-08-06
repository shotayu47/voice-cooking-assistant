import 'server-only';

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { z } from 'zod';

import {
  CATEGORIES,
  QUANTITY_STATES,
  STORAGE_LOCATIONS,
  type TransactionSource,
} from '@/types/domain';
import {
  consumeInventoryItem,
  createInventoryItem,
  findInventoryItemByName,
  listExpiringSoon,
  listInventory,
  updateInventoryItem,
  type ServiceContext,
} from '@/lib/inventory/service';
import { createRecipe } from '@/lib/recipes/service';
import {
  getCurrentStep,
  moveStep,
  startSession,
  updateStatus,
} from '@/lib/cooking/service';
import { isAvailable } from '@/lib/inventory/quantity';
import { freshnessOf } from '@/lib/inventory/freshness';
import type { InventoryItem } from '@/types/domain';

/**
 * Tool definitions (SPEC §8).
 *
 * Every tool runs server-side against the caller's RLS-scoped Supabase client.
 * Tool results are the model's only source of truth about state.
 */
export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_inventory',
      description:
        'ユーザーの現在の在庫を取得する。料理を提案する前、在庫に言及する前に必ず呼ぶこと。特定の食材があるか調べる目的なら category は必ず null にすること（カテゴリ未設定の食材が漏れるため）。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: ['string', 'null'],
            enum: [...CATEGORIES, null],
            description: 'カテゴリで絞り込む場合のみ指定',
          },
          include_empty: {
            type: 'boolean',
            description: '在庫切れ(empty)の食材も含めるか。既定は false。',
          },
        },
        required: ['category', 'include_empty'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_inventory_item',
      description:
        '食材名から在庫の item_id を1件に特定する。「玉ねぎ使い切った」のように特定の食材を変更する前は、get_inventory を全件走査せずこのツールを使うこと。表記ゆれ（鶏もも/鶏もも肉/チキン）も解決する。複数該当する場合は ambiguous を返すので、その時はユーザーに確認すること。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'ユーザーが言った食材名そのまま' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_inventory_item',
      description:
        '在庫に食材を追加する。名前だけで登録可能。数量が不明なら quantity を null にすること。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '食材名' },
          category: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
          quantity: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'], description: '個 / g / ml など' },
          quantity_state: { type: 'string', enum: [...QUANTITY_STATES] },
          storage_location: {
            type: ['string', 'null'],
            enum: [...STORAGE_LOCATIONS, null],
          },
          expiry_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          notes: { type: ['string', 'null'] },
        },
        required: [
          'name',
          'category',
          'quantity',
          'unit',
          'quantity_state',
          'storage_location',
          'expiry_date',
          'notes',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_inventory_item',
      description:
        '在庫の情報を更新する。変更するフィールドだけ値を入れ、それ以外は null にすること。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'get_inventory で得た id' },
          quantity: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          quantity_state: {
            type: ['string', 'null'],
            enum: [...QUANTITY_STATES, null],
          },
          opened: { type: ['boolean', 'null'] },
          expiry_date: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
        },
        required: [
          'item_id',
          'quantity',
          'unit',
          'quantity_state',
          'opened',
          'expiry_date',
          'notes',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consume_inventory_item',
      description:
        '食材を使った分だけ在庫を減らす。「使い切った」なら consume_all: true。使用量が不明な場合は amount を null にする（勝手な数量を作らないこと）。spoken_name にはユーザーが実際に言った食材名をそのまま入れること（サーバーが対象の取り違えを検証します）。',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          spoken_name: {
            type: 'string',
            description: 'ユーザーが言った食材名そのまま（例:「鶏肉」）。言い換えないこと。',
          },
          amount: { type: ['number', 'null'], description: '使用量。不明なら null' },
          unit: { type: ['string', 'null'] },
          consume_all: { type: 'boolean', description: '全部使い切った場合 true' },
        },
        required: ['item_id', 'spoken_name', 'amount', 'unit', 'consume_all'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_meal_candidates',
      description:
        '献立を考えるための材料コンテキスト（利用可能な在庫・期限が近い食材・不足しがちな基礎調味料）を取得する。この結果をもとに候補を3〜5件組み立てること。',
      parameters: {
        type: 'object',
        properties: {
          max_minutes: { type: ['number', 'null'], description: '調理時間の上限（分）' },
          meal_type: { type: ['string', 'null'], description: '主菜 / 副菜 / 丼 など' },
          style: { type: ['string', 'null'], description: '「ご飯に合う」「軽め」など' },
          difficulty: { type: ['string', 'null'], enum: ['easy', 'medium', 'hard', null] },
        },
        required: ['max_minutes', 'meal_type', 'style', 'difficulty'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_recipe',
      description:
        'レシピを保存する。steps は必ず1工程1動作に分割すること。返り値の recipe_id を start_cooking_session に渡す。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: ['string', 'null'] },
          servings: { type: 'integer' },
          estimated_minutes: { type: ['integer', 'null'] },
          difficulty: { type: ['string', 'null'], enum: ['easy', 'medium', 'hard', null] },
          ingredients: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                amount: { type: ['number', 'null'] },
                unit: { type: ['string', 'null'] },
                required: { type: 'boolean' },
                substitute_options: {
                  type: ['array', 'null'],
                  items: { type: 'string' },
                },
              },
              required: ['name', 'amount', 'unit', 'required', 'substitute_options'],
              additionalProperties: false,
            },
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                instruction: { type: 'string', description: '1工程1動作' },
                duration_seconds: { type: ['integer', 'null'] },
                heat_value: {
                  type: ['integer', 'null'],
                  description: 'IH 10段階での火力 (1-10)',
                },
                heat_label: { type: ['string', 'null'], description: '中火 / 強火 など' },
                ingredient_refs: { type: ['array', 'null'], items: { type: 'string' } },
                safety_note: { type: ['string', 'null'] },
              },
              required: [
                'instruction',
                'duration_seconds',
                'heat_value',
                'heat_label',
                'ingredient_refs',
                'safety_note',
              ],
              additionalProperties: false,
            },
          },
        },
        required: [
          'title',
          'description',
          'servings',
          'estimated_minutes',
          'difficulty',
          'ingredients',
          'steps',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_cooking_session',
      description: '保存済みレシピの調理を開始する。',
      parameters: {
        type: 'object',
        properties: { recipe_id: { type: 'string' } },
        required: ['recipe_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_cooking_step',
      description:
        '現在の工程を取得する。工程は進まない。時間・火力・分量を聞かれたらこれを使うこと。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'advance_cooking_step',
      description:
        '工程を1つ進める。「次」「できた」など、完了が明確な場合のみ呼ぶこと。質問に答えるだけのときは呼ばない。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'previous_cooking_step',
      description: '工程を1つ戻す。',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_cooking_session',
      description: '料理を終了する。完成なら completed、中断なら cancelled。',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'cancelled', 'paused'] },
        },
        required: ['session_id', 'status'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * The same tools in the Realtime API's flat format (Phase 2). One source of
 * truth: text and voice must never diverge on what the assistant can do.
 */
export function realtimeToolDefinitions() {
  return TOOL_DEFINITIONS.flatMap((tool) =>
    tool.type === 'function'
      ? [
          {
            type: 'function' as const,
            name: tool.function.name,
            description: tool.function.description ?? '',
            parameters: tool.function.parameters,
          },
        ]
      : [],
  );
}

export type ToolOutcome = {
  result: unknown;
  /** Set when the tool changed persistent state, so the UI can refresh. */
  effect?: 'inventory_changed' | 'session_changed';
  /** Set by start_cooking_session so the chat can link straight into cooking. */
  sessionId?: string;
};

/**
 * Execute one tool call. Errors are returned as data, not thrown: the model
 * needs to see the failure so it can ask the user instead of inventing a result.
 */
export async function executeTool(
  ctx: ServiceContext,
  name: string,
  rawArgs: string,
  source: TransactionSource = 'ai_text',
): Promise<ToolOutcome> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { result: { error: 'invalid_arguments', message: '引数のJSONが不正です' } };
  }

  try {
    return await dispatch(ctx, name, args, source);
  } catch (error) {
    return { result: describeToolFailure(name, error) };
  }
}

/**
 * Turn an exception into something the model can act on.
 *
 * Distinguishing "your arguments were wrong" from "the database is
 * unreachable" matters: the first should be retried with better arguments,
 * the second should be reported to the user rather than retried forever.
 */
function describeToolFailure(name: string, error: unknown) {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const field = issue?.path.join('.') || '引数';
    console.error(`[ai] tool ${name} rejected arguments:`, issue?.message);
    return {
      error: 'invalid_arguments',
      field,
      message: `${field} が不正です: ${issue?.message ?? '値を確認してください'}`,
      hint: '引数を修正して1回だけ再試行してください。同じ値で繰り返さないでください。',
    };
  }

  const raw = error instanceof Error ? error.message : String(error);
  console.error(`[ai] tool ${name} failed:`, raw);

  // Supabase/PostgREST surfaces aborts and network failures as fetch errors.
  if (/abort|timeout|fetch failed|network/i.test(raw)) {
    return {
      error: 'backend_unavailable',
      message: 'データベースに接続できませんでした。',
      hint: '在庫や工程が変更されたと仮定しないでください。ユーザーに少し待ってもう一度試すよう伝えてください。',
    };
  }

  return {
    error: 'tool_failed',
    message: raw,
    hint: '同じ操作を繰り返さず、ユーザーに状況を伝えてください。',
  };
}

async function dispatch(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
  source: TransactionSource,
): Promise<ToolOutcome> {
  switch (name) {
    case 'get_inventory': {
      const items = await listInventory(ctx, {
        category: (args.category as string | null) ?? null,
        includeEmpty: Boolean(args.include_empty),
      });
      return { result: { items: items.map(publicItem) } };
    }

    case 'find_inventory_item': {
      const resolution = await findInventoryItemByName(ctx, String(args.name ?? ''));

      if (resolution.status === 'matched') {
        return { result: { status: 'matched', item: publicItem(resolution.item) } };
      }
      if (resolution.status === 'ambiguous') {
        return {
          result: {
            status: 'ambiguous',
            candidates: resolution.candidates.map(publicItem),
            note: 'どれを指しているかユーザーに確認してください。勝手に選ばないでください。',
          },
        };
      }
      return {
        result: {
          status: 'not_found',
          note: 'この名前の食材は在庫にありません。あると仮定しないでください。',
        },
      };
    }

    case 'add_inventory_item': {
      const item = await createInventoryItem(
        ctx,
        {
          name: String(args.name ?? ''),
          category: (args.category as never) ?? null,
          quantity: (args.quantity as number | null) ?? null,
          unit: (args.unit as string | null) ?? null,
          quantity_state: (args.quantity_state as never) ?? 'available',
          storage_location: (args.storage_location as never) ?? null,
          expiry_date: (args.expiry_date as string | null) ?? null,
          notes: (args.notes as string | null) ?? null,
        },
        source,
      );
      return { result: { item: publicItem(item) }, effect: 'inventory_changed' };
    }

    case 'update_inventory_item': {
      const patch: Record<string, unknown> = {};
      for (const key of ['quantity', 'unit', 'quantity_state', 'opened', 'expiry_date', 'notes']) {
        if (args[key] !== undefined && args[key] !== null) patch[key] = args[key];
      }
      const item = await updateInventoryItem(ctx, String(args.item_id), patch, source);
      return { result: { item: publicItem(item) }, effect: 'inventory_changed' };
    }

    case 'consume_inventory_item': {
      // Backend validation, not a prompt request. The model can hold an
      // item_id from an earlier get_inventory and spend it on an ambiguous
      // utterance ("鶏肉使った" with two kinds of chicken in stock) without
      // ever calling find_inventory_item. Re-resolving what the user actually
      // said is the only place the server can catch that.
      const spokenName = typeof args.spoken_name === 'string' ? args.spoken_name : '';
      if (spokenName.trim()) {
        const resolution = await findInventoryItemByName(ctx, spokenName);

        if (resolution.status === 'ambiguous') {
          return {
            result: {
              status: 'needs_clarification',
              message: `「${spokenName}」に該当する食材が複数あります。`,
              candidates: resolution.candidates.map(publicItem),
              note: '在庫は変更していません。どれのことかユーザーに確認してください。',
            },
          };
        }

        if (resolution.status === 'matched' && resolution.item.id !== String(args.item_id)) {
          return {
            result: {
              status: 'needs_clarification',
              message: `「${spokenName}」は ${resolution.item.name} に解決されましたが、別の食材を変更しようとしています。`,
              resolved: publicItem(resolution.item),
              note: '在庫は変更していません。対象をユーザーに確認してください。',
            },
          };
        }
        // `not_found` falls through: the model may have used a name we cannot
        // resolve while holding a valid id from get_inventory. Refusing that
        // would block legitimate updates.
      }

      const outcome = await consumeInventoryItem(
        ctx,
        {
          itemId: String(args.item_id),
          amount: (args.amount as number | null) ?? null,
          unit: (args.unit as string | null) ?? null,
          consumeAll: Boolean(args.consume_all),
        },
        source,
      );

      if (outcome.status === 'needs_clarification') {
        return {
          result: {
            status: 'needs_clarification',
            message: outcome.reason,
            note: '在庫は変更されていません。ユーザーに確認してください。',
          },
        };
      }

      return {
        result: { status: 'applied', item: publicItem(outcome.item) },
        effect: 'inventory_changed',
      };
    }

    case 'search_meal_candidates': {
      const [items, expiring] = await Promise.all([
        listInventory(ctx, { includeEmpty: false }),
        listExpiringSoon(ctx, 5),
      ]);
      const usable = items.filter(isAvailable);
      return {
        result: {
          preferences: {
            max_minutes: args.max_minutes ?? null,
            meal_type: args.meal_type ?? null,
            style: args.style ?? null,
            difficulty: args.difficulty ?? null,
          },
          available_items: usable.map(publicItem),
          expiring_soon: expiring.map(({ item, freshness }) => ({
            ...publicItem(item),
            urgency: freshness.label,
          })),
          ranking_guidance: [
            '在庫だけで完結する料理を最優先',
            '賞味期限が近い食材を使う料理を次に優先',
            '不足材料が少ない順',
            '工程が少ない順',
          ],
          note: 'この一覧に無い食材は在庫にありません。あると仮定しないでください。',
        },
      };
    }

    case 'create_recipe': {
      const recipe = await createRecipe(ctx, toRecipeInput(args), 'ai');
      return {
        result: {
          recipe_id: recipe.id,
          title: recipe.title,
          total_steps: recipe.steps.length,
        },
      };
    }

    case 'start_cooking_session': {
      const session = await startSession(ctx, String(args.recipe_id));
      const view = await getCurrentStep(ctx, session.id);
      return {
        result: {
          session_id: session.id,
          current_step: session.current_step,
          total_steps: session.total_steps,
          step: view.step,
        },
        effect: 'session_changed',
        sessionId: session.id,
      };
    }

    case 'get_current_cooking_step': {
      const view = await getCurrentStep(ctx, String(args.session_id));
      return { result: stepResult(view) };
    }

    case 'advance_cooking_step': {
      const view = await moveStep(ctx, String(args.session_id), 'next', undefined, {
        aiInitiated: true,
      });
      return { result: stepResult(view), effect: 'session_changed', sessionId: view.session.id };
    }

    case 'previous_cooking_step': {
      const view = await moveStep(ctx, String(args.session_id), 'previous', undefined, {
        aiInitiated: true,
      });
      return { result: stepResult(view), effect: 'session_changed', sessionId: view.session.id };
    }

    case 'finish_cooking_session': {
      const status = String(args.status ?? 'completed') as
        | 'completed'
        | 'cancelled'
        | 'paused';
      const session = await updateStatus(ctx, String(args.session_id), status);
      return {
        result: { session_id: session.id, status: session.status },
        effect: 'session_changed',
        sessionId: session.id,
      };
    }

    default:
      return { result: { error: 'unknown_tool', message: `未知のツール: ${name}` } };
  }
}

/**
 * What the model is allowed to see about an item. Includes the freshness
 * summary so it can prioritise 期限が近い食材 without doing date arithmetic —
 * and so it can tell a printed date from the app's estimate.
 */
function publicItem(item: InventoryItem) {
  const freshness = freshnessOf(item);

  return {
    id: item.id,
    name: item.name,
    category: item.category,
    quantity: item.quantity,
    unit: item.unit,
    quantity_state: item.quantity_state,
    storage_location: item.storage_location,
    expiry_date: item.expiry_date,
    ...(freshness
      ? {
          days_left: freshness.daysLeft,
          expiry_kind: freshness.kind,
          expiry_is_estimated: freshness.estimated,
        }
      : {}),
  };
}

function stepResult(view: Awaited<ReturnType<typeof getCurrentStep>>) {
  return {
    session_id: view.session.id,
    current_step: view.session.current_step,
    step_number: view.stepNumber,
    total_steps: view.totalSteps,
    is_final_step: view.isFinalStep,
    status: view.session.status,
    instruction: view.step?.instruction ?? null,
    duration_seconds: view.step?.durationSeconds ?? null,
    heat: view.step?.heat ?? null,
    ingredient_refs: view.step?.ingredientRefs ?? [],
    safety_note: view.step?.safetyNote ?? null,
  };
}

/** Map the tool's flat step/ingredient shape onto the SPEC §9 recipe format. */
function toRecipeInput(args: Record<string, unknown>) {
  const ingredients = Array.isArray(args.ingredients) ? args.ingredients : [];
  const steps = Array.isArray(args.steps) ? args.steps : [];

  return {
    title: args.title,
    description: args.description ?? undefined,
    servings: args.servings ?? 1,
    estimatedMinutes: args.estimated_minutes ?? undefined,
    difficulty: args.difficulty ?? undefined,
    ingredients: ingredients.map((raw) => {
      const ingredient = raw as Record<string, unknown>;
      return {
        name: ingredient.name,
        amount: ingredient.amount ?? undefined,
        unit: ingredient.unit ?? undefined,
        required: ingredient.required ?? true,
        substituteOptions: (ingredient.substitute_options as string[] | null) ?? undefined,
      };
    }),
    steps: steps.map((raw, index) => {
      const step = raw as Record<string, unknown>;
      const heatValue = step.heat_value as number | null;
      const heatLabel = step.heat_label as string | null;
      return {
        index,
        instruction: step.instruction,
        durationSeconds: step.duration_seconds ?? undefined,
        heat:
          heatValue || heatLabel
            ? { type: 'ih_10' as const, value: heatValue ?? undefined, label: heatLabel ?? undefined }
            : undefined,
        ingredientRefs: (step.ingredient_refs as string[] | null) ?? undefined,
        safetyNote: step.safety_note ?? undefined,
      };
    }),
  };
}

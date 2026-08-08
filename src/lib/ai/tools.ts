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
import { createRecipe, getRecipe, toRecipeSnapshot } from '@/lib/recipes/service';
import {
  getCurrentStep,
  getOpenSession,
  getSession,
  moveStep,
  recordUsedIngredient,
  setSessionServings,
  startSession,
  updateStatus,
} from '@/lib/cooking/service';
import { ingredientProgress, maxServingsFromInventory } from '@/lib/recipes/capacity';
import {
  isValidServings,
  MAX_SERVINGS,
  resolveScaling,
  scaleRecipe,
  withTargetServings,
} from '@/lib/recipes/scale';
import { stepIngredientDetails } from '@/lib/cooking/steps';
import { isAvailable } from '@/lib/inventory/quantity';
import { freshnessOf } from '@/lib/inventory/freshness';
import {
  MEAL_CANDIDATE_BUCKET_LABELS,
  missingStaples,
  STAPLE_SEASONINGS,
  surplusItems,
} from '@/lib/meals/classification';
import { evaluateCandidates, MISSING_REASON_LABELS } from '@/lib/meals/evaluate';
import type { InventoryItem, Recipe } from '@/types/domain';

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
        `食材名から在庫を確認する。複数まとめて調べられる。表記ゆれ（鶏もも/鶏もも肉/チキン）も解決する。
用途は2つ:
・在庫を変更する前に item_id を特定する（「玉ねぎ使い切った」など）。複数該当なら ambiguous を返すのでユーザーに確認すること。
・代替品を提案する前に、その代替品を実際に持っているか確認する。**在庫にない物を代替案として挙げないこと。**
get_inventory を全件走査するより、こちらで名前を指定する方が確実。`,
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description:
              'ユーザーが言った食材名、または確認したい代替品の候補名。まとめて指定できる。',
          },
        },
        required: ['names'],
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
        `在庫の残量を更新する。ユーザーの言い方に応じて4つの指定方法から1つだけ選ぶこと。
・「全部使った」「使い切った」→ consume_all: true
・「2個使った」「300g使った」→ amount に使用量
・「あと2個」「残り300g」→ remaining に残っている量（減算ではなく残量そのもの）
・「半分使った」「3分の1使った」→ fraction に使った割合（半分なら0.5）
使用量も残量も割合も分からない場合は、すべて null にすること（勝手な数量を作らない）。
spoken_name にはユーザーが実際に言った食材名をそのまま入れること（サーバーが対象の取り違えを検証します）。`,
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          spoken_name: {
            type: 'string',
            description: 'ユーザーが言った食材名そのまま（例:「鶏肉」）。言い換えないこと。',
          },
          amount: { type: ['number', 'null'], description: '使った量。不明なら null' },
          remaining: {
            type: ['number', 'null'],
            description: '「あと2個」のように残量を言われた場合の残量。それ以外は null',
          },
          fraction: {
            type: ['number', 'null'],
            description: '「半分使った」なら0.5、「3分の1使った」なら0.33。それ以外は null',
          },
          unit: { type: ['string', 'null'] },
          consume_all: { type: 'boolean', description: '全部使い切った場合 true' },
        },
        required: [
          'item_id',
          'spoken_name',
          'amount',
          'remaining',
          'fraction',
          'unit',
          'consume_all',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_meal_candidates',
      description:
        `献立を考えるためのツール。2段階で使う。
1回目: candidates を null にして呼ぶ → 在庫・期限が近い食材・余っている食材が返る。
2回目: それを見て考えた候補3〜5件を candidates に入れて呼ぶ → サーバーが実際の在庫と
照合し、分類（作れる/調味料だけ不足/あと1品…）と不足材料を確定して返す。
**分類と不足材料は必ず2回目の結果をそのまま伝えること。自分で数え直さないこと。**
サーバーの判定と自分の見立てが違う場合は、サーバーの判定が正しい。`,
      parameters: {
        type: 'object',
        properties: {
          max_minutes: { type: ['number', 'null'], description: '調理時間の上限（分）' },
          meal_type: { type: ['string', 'null'], description: '主菜 / 副菜 / 丼 など' },
          style: { type: ['string', 'null'], description: '「ご飯に合う」「軽め」など' },
          difficulty: { type: ['string', 'null'], enum: ['easy', 'medium', 'hard', null] },
          mode: {
            type: ['string', 'null'],
            enum: ['fridge_cleanup', null],
            description:
              'ユーザーが「冷蔵庫整理」「余ってるもの使いたい」のように言った場合のみ fridge_cleanup を指定する。それ以外は null。',
          },
          candidates: {
            type: ['array', 'null'],
            description:
              '判定してほしい料理候補。1回目の呼び出しでは null。2回目に3〜5件入れる。',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '料理名' },
                required_ingredients: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'これが無いと作れない材料。調味料も含めてすべて挙げること。',
                },
                optional_ingredients: {
                  type: ['array', 'null'],
                  items: { type: 'string' },
                  description: 'あれば良い程度の材料。不足として数えない。',
                },
              },
              required: ['title', 'required_ingredients', 'optional_ingredients'],
              additionalProperties: false,
            },
          },
        },
        required: [
          'max_minutes',
          'meal_type',
          'style',
          'difficulty',
          'mode',
          'candidates',
        ],
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
  // PHASE 8. No existing tool owns "change the amounts", and folding it into
  // create_recipe would mean the model re-issuing every number — which is
  // exactly the arithmetic this tool exists to take away from it.
  {
    type: 'function',
    function: {
      name: 'adjust_recipe_amounts',
      description:
        `分量を計算するツール。**分量の掛け算を自分でしないこと。** 必ずこれを呼び、返ってきた数値をそのまま伝えること。
mode で用途を選ぶ:
・scale … 「4人分にして」「倍量で」「半分の量で」→ target_servings に作りたい人数を入れる。
・max_from_inventory … 「今ある分で何人分作れる?」→ target_servings は null。
session_id を渡すと、その調理セッションの分量として保存される（元のレシピの分量は書き換えない）。
加熱時間と火力は倍率変更しない。返ってきた notes をそのまま伝えること。
max_from_inventory の capacity_status が exact でない場合、「最大◯人分」と断定しないこと。`,
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['scale', 'max_from_inventory'],
            description: '人数を変えるなら scale、在庫の上限を知りたいなら max_from_inventory',
          },
          target_servings: {
            type: ['integer', 'null'],
            description: 'mode が scale のとき必須。作りたい人数（1〜20）。それ以外は null。',
          },
          session_id: {
            type: ['string', 'null'],
            description: '調理中ならそのセッションID。無ければ null（進行中の料理を自動で使う）。',
          },
          recipe_id: {
            type: ['string', 'null'],
            description: 'まだ調理を開始していない保存済みレシピを対象にする場合のみ指定。',
          },
        },
        required: ['mode', 'target_servings', 'session_id', 'recipe_id'],
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
        `工程を1つ進める。「次」「できた」など、完了が明確な場合のみ呼ぶこと。質問に答えるだけのときは呼ばない。
intent で「やった」のか「飛ばした」のかを区別する:
・done … 「できた」「終わった」→ 完了として記録
・skip … 「飛ばす」「これはやらない」「もう入れてある」→ スキップとして記録
どちらか分からない場合は done にせず、ユーザーに確認すること。`,
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          intent: {
            type: 'string',
            enum: ['done', 'skip'],
            description: '工程を完了したのか飛ばしたのか',
          },
        },
        required: ['session_id', 'intent'],
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

/** Shape the model must submit for a candidate. Validated before use. */
const candidateSubmissionSchema = z.array(
  z.object({
    title: z.string().trim().min(1).max(100),
    required_ingredients: z.array(z.string().trim().min(1).max(100)).max(30),
    optional_ingredients: z.array(z.string().trim().min(1).max(100)).max(30).nullable().optional(),
  }),
).max(10);

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
      // Accepts a batch so a substitution answer can check every candidate in
      // one call. `name` stays accepted for older single-name call sites.
      const requested = Array.isArray(args.names)
        ? args.names.map(String)
        : args.name !== undefined
          ? [String(args.name)]
          : [];

      const names = requested.map((value) => value.trim()).filter(Boolean).slice(0, 10);
      if (names.length === 0) {
        return {
          result: { error: 'invalid_arguments', message: '確認したい食材名を指定してください。' },
        };
      }

      const results = await Promise.all(
        names.map(async (name) => {
          const resolution = await findInventoryItemByName(ctx, name);

          if (resolution.status === 'matched') {
            return { name, status: 'matched' as const, item: publicItem(resolution.item) };
          }
          if (resolution.status === 'ambiguous') {
            return {
              name,
              status: 'ambiguous' as const,
              candidates: resolution.candidates.map(publicItem),
            };
          }
          return { name, status: 'not_found' as const };
        }),
      );

      // Single-name calls keep their original shape so nothing downstream has
      // to special-case the batch.
      if (results.length === 1 && !Array.isArray(args.names)) {
        const only = results[0];
        return {
          result: {
            status: only.status,
            ...(only.status === 'matched' ? { item: only.item } : {}),
            ...(only.status === 'ambiguous'
              ? {
                  candidates: only.candidates,
                  note: 'どれを指しているかユーザーに確認してください。勝手に選ばないでください。',
                }
              : {}),
            ...(only.status === 'not_found'
              ? { note: 'この名前の食材は在庫にありません。あると仮定しないでください。' }
              : {}),
          },
        };
      }

      return {
        result: {
          results,
          note:
            'not_found の食材は在庫にありません。代替案として挙げないでください。' +
            'ambiguous はどれを指すかユーザーに確認してください。',
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
          remaining: (args.remaining as number | null) ?? null,
          fraction: (args.fraction as number | null) ?? null,
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

      // Cooking in progress? Record what was actually used, so the finished
      // session carries the real ingredient list rather than the recipe's.
      const openSession = await getOpenSession(ctx);
      if (openSession) {
        await recordUsedIngredient(ctx, openSession.id, {
          name: outcome.item.name,
          inventoryItemId: outcome.item.id,
          amount: (args.amount as number | null) ?? null,
          unit: (args.unit as string | null) ?? outcome.item.unit,
          stepIndex: openSession.current_step,
        });
      }

      return {
        result: { status: 'applied', item: publicItem(outcome.item) },
        effect: 'inventory_changed',
      };
    }

    case 'search_meal_candidates': {
      const mode = args.mode === 'fridge_cleanup' ? 'fridge_cleanup' : 'normal';
      // 冷蔵庫整理モードでは「もうすぐ切れる」の範囲を広げ、多めに拾う。
      const expiringWindowDays = mode === 'fridge_cleanup' ? 7 : 5;

      const [items, expiring] = await Promise.all([
        listInventory(ctx, { includeEmpty: false }),
        listExpiringSoon(ctx, expiringWindowDays),
      ]);
      const usable = items.filter(isAvailable);

      // Second call: the model has proposed dishes. Whether each is actually
      // makeable is a fact about the fridge, so it is decided here — the
      // model's own count is not consulted.
      const submitted = Array.isArray(args.candidates) ? args.candidates : null;
      if (submitted && submitted.length > 0) {
        const parsed = candidateSubmissionSchema.safeParse(submitted);
        if (!parsed.success) {
          return {
            result: {
              error: 'invalid_candidates',
              message: '候補の形式が不正です。title と required_ingredients を入れてください。',
            },
          };
        }

        const verdicts = evaluateCandidates(
          parsed.data.map((candidate) => ({
            title: candidate.title,
            requiredIngredients: candidate.required_ingredients,
            optionalIngredients: candidate.optional_ingredients ?? undefined,
          })),
          items,
          { expiring: expiring.map(({ item }) => item), mode },
        );

        return {
          result: {
            mode,
            evaluated_candidates: verdicts.map((verdict) => ({
              title: verdict.title,
              bucket: verdict.bucket,
              bucket_label: verdict.bucketLabel,
              missing: verdict.missing.map((entry) => ({
                name: entry.name,
                reason: entry.reason,
                reason_label: MISSING_REASON_LABELS[entry.reason],
                is_staple: entry.isStaple,
              })),
              on_hand: verdict.onHand,
              uses_expiring: verdict.usesExpiring,
              expiring_used: verdict.expiringUsed,
            })),
            note:
              'この分類と不足材料はサーバーが実在庫と照合して確定したものです。' +
              'そのまま伝えてください。数え直したり、別の分類を付けたりしないでください。' +
              'not_feasible の候補は提案しないでください。並び順は提案順の推奨です。',
          },
        };
      }

      const rankingGuidance =
        mode === 'fridge_cleanup'
          ? [
              '賞味期限が近い食材・余っている食材（surplus_items）を使う料理を最優先',
              '在庫だけで完結する料理を次に優先',
              '不足材料が少ない順',
              '工程が少ない順',
            ]
          : [
              '在庫だけで完結する料理を最優先',
              '賞味期限が近い食材を使う料理を次に優先',
              '不足材料が少ない順',
              '工程が少ない順',
            ];

      return {
        result: {
          mode,
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
          surplus_items: surplusItems(usable).map(publicItem),
          missing_staples: missingStaples(items),
          classification_guide: {
            buckets: MEAL_CANDIDATE_BUCKET_LABELS,
            staple_seasonings: STAPLE_SEASONINGS,
            instructions:
              'この一覧をもとに候補を3〜5件考え、search_meal_candidates を candidates 付きで' +
              'もう一度呼んでください。分類と不足材料はサーバーが確定して返します。' +
              '自分で分類せず、返ってきた bucket_label と missing をそのまま伝えてください。',
          },
          ranking_guidance: rankingGuidance,
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

    case 'adjust_recipe_amounts': {
      const mode = args.mode === 'max_from_inventory' ? 'max_from_inventory' : 'scale';
      const sessionId =
        typeof args.session_id === 'string' && args.session_id.trim()
          ? args.session_id.trim()
          : null;
      const recipeId =
        typeof args.recipe_id === 'string' && args.recipe_id.trim()
          ? args.recipe_id.trim()
          : null;

      // A session's snapshot wins: it is what the user is cooking right now.
      // Only fall back to the open session when no explicit target was named.
      let session = sessionId ? await getSession(ctx, sessionId) : null;
      if (!session && !sessionId && !recipeId) session = await getOpenSession(ctx);

      let recipe: Recipe | null = session ? (session.recipe_snapshot as Recipe) : null;
      if (!recipe && recipeId) {
        const stored = await getRecipe(ctx, recipeId);
        recipe = stored ? toRecipeSnapshot(stored) : null;
      }

      if (!recipe) {
        return {
          result: {
            error: 'recipe_not_found',
            message: '分量を調整する対象のレシピが見つかりません。',
            hint: '先に create_recipe でレシピを保存するか、調理を開始してください。分量を自分で計算しないでください。',
          },
        };
      }

      if (mode === 'max_from_inventory') {
        // include_empty: an item that exists but is empty is 在庫切れ, which is
        // a different answer from 在庫にない.
        const items = await listInventory(ctx, { includeEmpty: true });
        const capacity = maxServingsFromInventory(recipe, items);
        const current = resolveScaling(recipe);

        return {
          result: {
            mode,
            base_servings: current.baseServings,
            current_target_servings: current.targetServings,
            capacity_status: capacity.status,
            max_servings: capacity.maxServings,
            capped_at_max: capacity.cappedAtMax,
            limiting_ingredient: capacity.limiting,
            verified_constraints: capacity.verified,
            unverified_constraints: capacity.unverified,
            note:
              capacity.status === 'exact'
                ? 'すべての必須材料を実在庫と照合済みです。'
                : capacity.status === 'partial'
                  ? '一部の材料は確認できていません。「確認できる範囲では最大◯人分」と伝え、' +
                    'unverified_constraints の材料はユーザーに確認してください。断定しないでください。'
                  : '在庫と照合できた材料がありません。人数の上限を答えないでください。',
          },
        };
      }

      const target = args.target_servings;
      if (!isValidServings(target)) {
        return {
          result: {
            error: 'invalid_arguments',
            field: 'target_servings',
            message: `作りたい人数を1〜${MAX_SERVINGS}の整数で指定してください。`,
            hint: 'ユーザーが人数を言っていない場合は、勝手に決めず聞いてください。',
          },
        };
      }

      // Persisting is what makes the cooking screen and the next answer agree.
      // Without a session there is nothing to persist — the calculation is
      // still returned, it just is not remembered.
      let saved = false;
      let scaledRecipe = withTargetServings(recipe, target);
      if (session) {
        const view = await setSessionServings(ctx, session.id, target);
        session = view.session;
        scaledRecipe = session.recipe_snapshot as Recipe;
        saved = true;
      }

      const scaled = scaleRecipe(scaledRecipe);
      const progress = session
        ? ingredientProgress(scaledRecipe, {
            usedIngredients: session.used_ingredients ?? [],
            completedSteps: session.completed_steps ?? [],
          }).filter((entry) => entry.status !== 'not_started')
        : [];

      return {
        result: {
          mode,
          base_servings: scaled.baseServings,
          target_servings: scaled.targetServings,
          factor: Math.round(scaled.factor * 1000) / 1000,
          saved,
          ingredients: scaled.ingredients.map((ingredient) => ({
            name: ingredient.name,
            amount: ingredient.amount,
            unit: ingredient.unit,
            display: ingredient.display,
            policy: ingredient.policy,
            required: ingredient.required,
            ...(ingredient.note ? { note: ingredient.note } : {}),
          })),
          notes: scaled.notes,
          ...(progress.length > 0 ? { already_added: progress } : {}),
          note:
            'この数値はサーバーが基準レシピから計算したものです。そのまま伝えてください。' +
            '掛け算をやり直さないでください。加熱時間と火力は変更していません。' +
            (progress.length > 0
              ? ' already_added はすでに入れた分です。status が unknown のものは量が記録されていないので、' +
                '入れた量を断定せずユーザーに確認してください。'
              : ''),
        },
        ...(saved ? { effect: 'session_changed' as const, sessionId: session!.id } : {}),
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
        intent: args.intent === 'skip' ? 'skip' : 'done',
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
  const recipe = view.session.recipe_snapshot as Recipe;
  const scaling = resolveScaling(recipe);

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
    // PHASE 8. The tool description has always claimed this answers 分量
    // questions, but it only ever returned names — leaving the model to recall
    // amounts from the conversation. These are the amounts for the servings
    // this session is actually cooking.
    ingredients: stepIngredientDetails(recipe, view.session.current_step).map(
      (ingredient) => ({
        name: ingredient.name,
        amount: ingredient.amount,
        unit: ingredient.unit,
        display: ingredient.display,
        policy: ingredient.policy,
      }),
    ),
    base_servings: scaling.baseServings,
    target_servings: scaling.targetServings,
    servings_adjusted: scaling.adjusted,
    safety_note: view.step?.safetyNote ?? null,
    // Progress detail so the assistant can answer 「あと何工程？」 and知る
    // which steps were skipped rather than done.
    completed_steps: view.progress.completed,
    skipped_steps: view.progress.skipped,
    remaining_steps: view.progress.remaining,
    all_steps_accounted_for: view.progress.isFinished,
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

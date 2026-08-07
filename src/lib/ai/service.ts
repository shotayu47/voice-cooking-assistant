import 'server-only';

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import { listInventory, ServiceError, type ServiceContext } from '@/lib/inventory/service';
import { isAvailable } from '@/lib/inventory/quantity';
import { freshnessOf } from '@/lib/inventory/freshness';
import { getOpenSession, getSession } from '@/lib/cooking/service';
import type { CookingSession, Profile } from '@/types/domain';
import { CHAT_MODEL, getOpenAI } from './openai';
import { buildSystemPrompt, type InventorySnapshotItem } from './prompt';
import { TOOL_DEFINITIONS, executeTool } from './tools';

/** Hard ceiling on tool round-trips per user message. */
const MAX_TOOL_ITERATIONS = 8;

/** How much history to replay. Older turns are dropped, not summarised. */
const HISTORY_LIMIT = 60;

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls: ChatCompletionMessageToolCall[] | null;
  tool_call_id: string | null;
  created_at: string;
};

export async function getOrCreateConversation(
  ctx: ServiceContext,
  cookingSessionId?: string | null,
): Promise<string> {
  const { data: existing, error: selectError } = await ctx.supabase
    .from('conversation_sessions')
    .select('id')
    .eq('user_id', ctx.userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) throw new ServiceError(selectError.message);
  if (existing) return existing.id as string;

  const { data, error } = await ctx.supabase
    .from('conversation_sessions')
    .insert({
      user_id: ctx.userId,
      cooking_session_id: cookingSessionId ?? null,
      status: 'active',
    })
    .select('id')
    .single();

  if (error) throw new ServiceError(error.message);
  return data.id as string;
}

export async function loadMessages(
  ctx: ServiceContext,
  conversationId: string,
): Promise<StoredMessage[]> {
  const { data, error } = await ctx.supabase
    .from('conversation_messages')
    .select('id, role, content, tool_calls, tool_call_id, created_at, seq')
    .eq('user_id', ctx.userId)
    .eq('conversation_session_id', conversationId)
    .order('seq', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new ServiceError(error.message);

  const rows = ((data ?? []) as StoredMessage[]).reverse();
  return redactStaleReads(dropOrphanedToolMessages(rows));
}

/**
 * A `tool` message whose originating `assistant` call fell outside the history
 * window is a protocol error. Drop leading orphans rather than send them.
 */
function dropOrphanedToolMessages(rows: StoredMessage[]): StoredMessage[] {
  const seenCallIds = new Set<string>();
  const kept: StoredMessage[] = [];

  for (const row of rows) {
    if (row.role === 'assistant' && row.tool_calls) {
      for (const call of row.tool_calls) seenCallIds.add(call.id);
    }
    if (row.role === 'tool' && (!row.tool_call_id || !seenCallIds.has(row.tool_call_id))) {
      continue;
    }
    kept.push(row);
  }

  // An assistant turn whose tool results were all dropped would also be
  // invalid; trim any trailing tool_calls message with no following results.
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last.role === 'assistant' && last.tool_calls?.length) {
      const answered = kept.some(
        (row) => row.role === 'tool' && last.tool_calls!.some((c) => c.id === row.tool_call_id),
      );
      if (!answered) {
        kept.pop();
        continue;
      }
    }
    break;
  }

  return kept;
}

/**
 * Tools whose result describes the inventory at one moment. Replaying an old
 * one asserts something that may since have become false — and it did: after
 * 砂糖 was added, the model kept reporting it missing because a `not_found`
 * from two turns earlier was still in the transcript, outweighing both the
 * system prompt and the real database.
 *
 * Mutation results and ids (create_recipe, start_cooking_session, …) stay:
 * those are records of what happened, which does not expire.
 */
const STALE_ON_REPLAY = new Set([
  'get_inventory',
  'find_inventory_item',
  'search_meal_candidates',
]);

const STALE_NOTE = JSON.stringify({
  note: 'この結果は過去の時点のものです。現在の在庫はシステムプロンプトの一覧が正です。必要ならツールで取り直してください。',
});

/**
 * Blank out inventory readings from earlier turns, keeping the message
 * structure intact so the tool-call protocol stays valid.
 */
export function redactStaleReads(rows: StoredMessage[]): StoredMessage[] {
  const staleCallIds = new Set<string>();

  for (const row of rows) {
    if (row.role !== 'assistant' || !row.tool_calls) continue;
    for (const call of row.tool_calls) {
      if (call.type === 'function' && STALE_ON_REPLAY.has(call.function.name)) {
        staleCallIds.add(call.id);
      }
    }
  }

  return rows.map((row) =>
    row.role === 'tool' && row.tool_call_id && staleCallIds.has(row.tool_call_id)
      ? { ...row, content: STALE_NOTE }
      : row,
  );
}

function toChatMessage(row: StoredMessage): ChatCompletionMessageParam {
  if (row.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: row.tool_call_id!,
      content: row.content ?? '',
    };
  }
  if (row.role === 'assistant') {
    return {
      role: 'assistant',
      content: row.content ?? '',
      ...(row.tool_calls?.length ? { tool_calls: row.tool_calls } : {}),
    };
  }
  return { role: 'user', content: row.content ?? '' };
}

async function persistMessage(
  ctx: ServiceContext,
  conversationId: string,
  message: {
    role: 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ChatCompletionMessageToolCall[] | null;
    tool_call_id?: string | null;
  },
): Promise<void> {
  const { error } = await ctx.supabase.from('conversation_messages').insert({
    conversation_session_id: conversationId,
    user_id: ctx.userId,
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls ?? null,
    tool_call_id: message.tool_call_id ?? null,
  });

  if (error) throw new ServiceError(error.message);
}

export type TurnResult = {
  reply: string;
  /** Tool names invoked, in order. Useful for tests and debugging. */
  toolsUsed: string[];
  inventoryChanged: boolean;
  /** The cooking session the turn ended on, if any. */
  cookingSessionId: string | null;
};

/**
 * Run one user turn: persist the message, let the model call tools until it
 * produces text, persist everything, and return the reply.
 */
export async function runTurn(
  ctx: ServiceContext,
  input: {
    conversationId: string;
    userMessage: string;
    cookingSessionId?: string | null;
  },
): Promise<TurnResult> {
  const text = input.userMessage.trim();
  if (!text) throw new ServiceError('メッセージが空です');

  await persistMessage(ctx, input.conversationId, { role: 'user', content: text });

  const session = input.cookingSessionId
    ? await getSession(ctx, input.cookingSessionId)
    : await getOpenSession(ctx);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt({
      profile: await loadProfile(ctx),
      session,
      today: new Date().toISOString().slice(0, 10),
      mode: 'text',
      // Rebuilt every turn, so this is always current — which stops the model
      // answering "do you have sugar?" from a tool result two turns old.
      inventory: await loadInventorySnapshot(ctx),
    }) },
    ...(await loadMessages(ctx, input.conversationId)).map(toChatMessage),
  ];

  const openai = getOpenAI();
  const toolsUsed: string[] = [];
  let inventoryChanged = false;
  let cookingSessionId = session?.id ?? null;

  // Backend guards, not prompt requests: one utterance may move the step at
  // most once, and an identical mutation repeated inside a turn is a model
  // slip rather than an instruction to do it twice.
  let stepMovesThisTurn = 0;
  const appliedMutations = new Map<string, unknown>();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.4,
      });
    } catch (error) {
      // The model call failed — but tools that already ran have committed
      // real changes. Throwing here would show a generic error while the
      // inventory silently moved, and a retry would apply it a second time.
      // Report what actually happened instead.
      if (toolsUsed.length > 0) {
        const reply = describeCompletedWork(toolsUsed, inventoryChanged);
        await persistMessage(ctx, input.conversationId, { role: 'assistant', content: reply });
        return { reply, toolsUsed, inventoryChanged, cookingSessionId };
      }
      throw error;
    }

    const choice = completion.choices[0]?.message;
    if (!choice) throw new ServiceError('AIから応答がありませんでした');

    const toolCalls = (choice.tool_calls ?? []) as ChatCompletionMessageToolCall[];

    await persistMessage(ctx, input.conversationId, {
      role: 'assistant',
      content: choice.content ?? '',
      tool_calls: toolCalls.length ? toolCalls : null,
    });

    messages.push({
      role: 'assistant',
      content: choice.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (!toolCalls.length) {
      return {
        reply: choice.content?.trim() || '…',
        toolsUsed,
        inventoryChanged,
        cookingSessionId,
      };
    }

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const name = call.function.name;
      toolsUsed.push(name);

      const mutationKey = isMutation(name) ? `${name}:${call.function.arguments}` : null;

      let outcome;
      if (isStepMove(name) && stepMovesThisTurn >= 1) {
        outcome = {
          result: {
            error: 'step_move_already_applied',
            message:
              'この発話ではすでに工程を移動しています。現在の工程をそのまま案内してください。',
          },
        };
      } else if (mutationKey && appliedMutations.has(mutationKey)) {
        outcome = {
          result: {
            error: 'already_applied',
            message: 'この変更はすでに適用済みです。同じ操作を繰り返さないでください。',
            previous_result: appliedMutations.get(mutationKey),
          },
        };
      } else {
        outcome = await executeTool(ctx, name, call.function.arguments, 'ai_text');
        if (isStepMove(name)) stepMovesThisTurn += 1;
        if (mutationKey) appliedMutations.set(mutationKey, outcome.result);
      }

      if (outcome.effect === 'inventory_changed') inventoryChanged = true;
      if (outcome.sessionId) cookingSessionId = outcome.sessionId;

      const content = JSON.stringify(outcome.result);
      await persistMessage(ctx, input.conversationId, {
        role: 'tool',
        content,
        tool_call_id: call.id,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  const fallback = 'うまくまとめられませんでした。もう一度、短く言い直してもらえますか。';
  await persistMessage(ctx, input.conversationId, { role: 'assistant', content: fallback });
  return { reply: fallback, toolsUsed, inventoryChanged, cookingSessionId };
}

/**
 * Plain-language account of what a turn managed to do before the model call
 * failed. Deliberately concrete about the inventory: the point is that the
 * user knows not to say it again.
 */
function describeCompletedWork(toolsUsed: string[], inventoryChanged: boolean): string {
  if (inventoryChanged) {
    return [
      '在庫の変更は反映されましたが、返答の生成に失敗しました。',
      '同じ操作をもう一度言うと二重に反映されるので、在庫画面で結果を確認してください。',
    ].join('\n');
  }

  const stepMoved = toolsUsed.some(isStepMove);
  if (stepMoved) {
    return '工程は進みましたが、返答の生成に失敗しました。画面を再読み込みしてください。';
  }

  return '返答の生成に失敗しました。もう一度お試しください。在庫は変更されていません。';
}

function isStepMove(name: string): boolean {
  return name === 'advance_cooking_step' || name === 'previous_cooking_step';
}

/** Tools that change persistent state and must not run twice per turn. */
const MUTATING_TOOLS = new Set([
  'add_inventory_item',
  'update_inventory_item',
  'consume_inventory_item',
  'create_recipe',
  'start_cooking_session',
  'finish_cooking_session',
]);

function isMutation(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

/** Compact inventory for the system prompt: what they have, how much, urgency. */
async function loadInventorySnapshot(
  ctx: ServiceContext,
): Promise<InventorySnapshotItem[]> {
  const items = await listInventory(ctx, { includeEmpty: false });

  return items.filter(isAvailable).map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    daysLeft: freshnessOf(item)?.daysLeft ?? null,
  }));
}

async function loadProfile(
  ctx: ServiceContext,
): Promise<Pick<Profile, 'preferred_heat_scale' | 'cooking_skill_level'> | null> {
  const { data } = await ctx.supabase
    .from('profiles')
    .select('preferred_heat_scale, cooking_skill_level')
    .eq('id', ctx.userId)
    .maybeSingle();

  return (data as Pick<Profile, 'preferred_heat_scale' | 'cooking_skill_level'> | null) ?? null;
}

export type { CookingSession };

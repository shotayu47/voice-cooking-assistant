/**
 * The reply that follows a recipe tool which already carried its candidates.
 *
 * "レシピを作って、足りない材料も教えて" used to cost three responses: the one
 * that called `create_recipe`, a continuation that called
 * `suggest_shopping_items`, and a third for the sentence. Every response
 * re-sends the conversation, and the token allowance — not the latency — is
 * what runs out. With the candidates folded into the recipe tool's own result
 * (`shopping_suggestions_included`), the middle response has nothing left to
 * do, and the turn is one automatic response plus one reply.
 *
 * Removing the middle response is only half of it. Nothing stops the model
 * calling `suggest_shopping_items` anyway — it has the tool, and the habit —
 * which would put the third response straight back. So the reply is asked for
 * with `tool_choice: 'none'`: not a request to refrain, but a response that
 * cannot contain a tool call at all.
 *
 * Deliberately separate from the forced final. That one is a recovery: the
 * budget is spent, the turn is in trouble, and `canRetry` is false afterwards
 * so the same wall is not hit twice. This one is the ordinary, successful end
 * of a turn that simply has everything it needs. Reusing those instructions
 * would tell a healthy turn it had been cut off.
 *
 * Pure: no I/O, no state. The decision is made from the tool result the client
 * already has in hand.
 */

/** Tools that can fold shopping candidates into their own result. */
export const SUGGESTION_CARRYING_TOOLS: ReadonlySet<string> = new Set([
  'create_recipe',
  'revise_recipe',
]);

/**
 * Did this result already answer the candidates half of the request?
 *
 * Read from the flag the server sets, not from the presence of candidates: a
 * failed computation and an empty one both still mean the model asked for them
 * and will not be calling the other tool. The reply is final either way.
 */
export function carriesIntegratedSuggestions(tool: string, result: unknown): boolean {
  if (!SUGGESTION_CARRYING_TOOLS.has(tool)) return false;
  if (!result || typeof result !== 'object') return false;

  return (result as { shopping_suggestions_handled?: unknown }).shopping_suggestions_handled
    === true;
}

/**
 * The answer to "save this recipe" when the identical recipe was already saved
 * this turn and only the candidate mode has changed.
 *
 * The row is not written again — the point of the whole path — so what the
 * model gets back is the result of the first save, with the candidates it is
 * now asking for read fresh against the recipe that already exists. The
 * candidates half is replaced rather than merged: an older list computed under
 * a different mode is not an answer to this request.
 */
export function reusedRecipeOutput(
  previousResult: unknown,
  suggestions: readonly unknown[] | null,
): unknown {
  const base =
    previousResult && typeof previousResult === 'object'
      ? { ...(previousResult as Record<string, unknown>) }
      : {};

  return {
    ...base,
    shopping_suggestions_handled: true,
    // `null` is the read having failed, which is not the same answer as an
    // empty list — and neither is a reason to save the recipe again.
    shopping_suggestions:
      suggestions === null
        ? {
            status: 'failed',
            message:
              'レシピは保存済みですが、買い物候補を取得できませんでした。レシピがあることを伝え、候補が必要ならもう一度尋ねるよう案内してください。',
            retry_hint:
              'このターンでレシピを作り直さないでください。候補は次のユーザー発話で suggest_shopping_items を使って取得できます。',
          }
        : {
            status: suggestions.length === 0 ? 'empty' : 'ok',
            suggestions,
            added: false,
            note:
              suggestions.length === 0
                ? '不足している材料はありませんでした。買い足すものはありません、と伝えてください。'
                : 'まだ何も追加していません。画面のカードでユーザーが選んだものだけが買い物リストに入ります。「追加しました」と言わないでください。',
          },
    repeated: true,
    note: 'このレシピは同じ内容ですでに保存済みです。作り直していないので、同じ recipe_id を使ってください。買い物候補だけを取得しました。',
  };
}

/**
 * What the model is told when the recipe and its candidates both came back in
 * one result.
 *
 * The failure sentence is here rather than only in the tool result because
 * this is the response that has to say it out loud: the recipe was saved, the
 * candidates were not, and — the part that matters — the recipe must not be
 * created again to try for them.
 */
export const INTEGRATED_FINAL_INSTRUCTIONS = [
  'レシピと買い物候補の結果はすでに揃っています。この応答で回答を完成させてください。',
  'これ以上ツールを呼び出すことはできません。suggest_shopping_items を呼ぼうとしないでください。同じ候補をもう一度計算することになります。',
  // Same failure the forced final guards against: the device said
  // 「候補を上げるから待って」 and then stopped, because nothing runs after
  // this response.
  '「お待ちください」「あとで」「これから調べます」など、この応答のあとに何かを実行すると約束してはいけません。',
  '候補が 0 件だったときは「買い足すものはありません」と伝えてください。',
  '候補の取得に失敗していた場合は、レシピは保存できたこと、候補だけ取得できなかったことを伝えてください。レシピを作り直してはいけません。',
].join('\n');

/** A `response.create` to send, and the label the trace records it under. */
export type ContinuationRequest = {
  payload: { type: 'response.create'; response?: Record<string, unknown> };
  purpose: 'continuation' | 'integrated_final';
};

/**
 * The response to ask for after handing back a tool's output.
 *
 * An ordinary tool gets an ordinary continuation — it may well need another
 * tool, and the budget is there for that. A recipe tool that brought its
 * candidates with it gets the closing reply, with tools switched off.
 */
export function continuationAfterTool(tool: string, result: unknown): ContinuationRequest {
  if (!carriesIntegratedSuggestions(tool, result)) {
    return { payload: { type: 'response.create' }, purpose: 'continuation' };
  }

  return {
    payload: {
      type: 'response.create',
      response: {
        tool_choice: 'none',
        // Tells the trace which design produced this response, so a turn that
        // still costs three can be told from one that costs two.
        metadata: { purpose: 'integrated_final' },
        instructions: INTEGRATED_FINAL_INSTRUCTIONS,
      },
    },
    purpose: 'integrated_final',
  };
}

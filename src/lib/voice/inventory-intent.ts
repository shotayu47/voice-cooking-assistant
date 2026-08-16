/**
 * Did the user ask for something to go into the *inventory*?
 *
 * "かつお節を買い物候補に入れて" created an inventory row. The user was asking
 * for it to appear among the shopping candidates; what they got was a claim
 * that they already had 10g of it in the pantry — which then makes it
 * ineligible as a shopping candidate, so the request defeated itself.
 *
 * There is no tool for "add this to the candidates": `suggest_shopping_items`
 * derives candidates from a recipe's ingredients and takes no additions. So
 * the model reached for the nearest write it had. The gate below stops that
 * write; giving the request a correct home is a separate piece of work.
 *
 * Fail-closed, like the cooking-step gate: an inventory row appears only when
 * the utterance can be positively read as saying the food is *here*.
 */

export type InventoryIntent =
  /** The food is in the house. Adding a row is what was asked for. */
  | 'inventory'
  /** The food is wanted, not held. An inventory row would be a false claim. */
  | 'shopping'
  | 'ambiguous';

/**
 * Phrases about buying, needing, or listing.
 *
 * These are whole phrases, never the bare character 買 — "買ってきたので在庫に
 * 追加して" is an inventory statement that happens to mention buying, and
 * matching on one character would reject it.
 */
const SHOPPING_MARKERS = [
  '買い物候補',
  '買い物リスト',
  '買うもの',
  '買うリスト',
  '買い物',
  '候補に入れ',
  '候補に追加',
  'リストに入れ',
  'リストに追加',
  '買っておく',
  '買わないと',
  '買う必要',
  '必要',
  '足りない',
  '切らして',
];

/**
 * Phrases placing the food in the user's possession.
 *
 * A storage location, or an explicit statement of having it.
 */
const INVENTORY_MARKERS = [
  '在庫',
  '冷蔵庫',
  '冷凍庫',
  'パントリー',
  '棚に',
  'ストック',
  '家に',
  'うちに',
  '手元に',
  '買ってきた',
  '買ってある',
  'もらった',
];

export function classifyInventoryUtterance(
  transcript: string | null | undefined,
): InventoryIntent {
  if (typeof transcript !== 'string') return 'ambiguous';

  const text = transcript.trim().replace(/[。、．，!！?？\s]/g, '');
  if (text === '') return 'ambiguous';

  const wantsToBuy = SHOPPING_MARKERS.some((marker) => text.includes(marker));
  const alreadyHasIt = INVENTORY_MARKERS.some((marker) => text.includes(marker));

  // Both readings present — "家に無いから買い物リストに入れて" — is a refusal.
  // Writing a possession the user may not have is the failure being avoided.
  if (alreadyHasIt && !wantsToBuy) return 'inventory';
  if (wantsToBuy && !alreadyHasIt) return 'shopping';
  return 'ambiguous';
}

export type InventoryDecision = 'allow' | 'refuse_shopping_intent' | 'refuse_unclear';

/**
 * `transcript` must be the recognition result for the *same committed turn* as
 * the tool call, or null when the two cannot be correlated. Null is a refusal:
 * a possession recorded against the wrong utterance is exactly the mistake.
 */
export function decideInventoryAdd(transcript: string | null | undefined): InventoryDecision {
  const intent = classifyInventoryUtterance(transcript);
  if (intent === 'inventory') return 'allow';
  return intent === 'shopping' ? 'refuse_shopping_intent' : 'refuse_unclear';
}

/**
 * What goes back to the model when the write is refused.
 *
 * It still needs an output for that `call_id`, and it needs to know that the
 * inventory was *not* touched — otherwise it tells the user the opposite. The
 * shopping case also names where the request should go, since the model's
 * only other option is to invent one.
 */
export function refusedInventoryOutput(decision: InventoryDecision): unknown {
  const message =
    decision === 'refuse_shopping_intent'
      ? [
          'ユーザーは「買いたい／候補に入れたい」と言っており、在庫があるとは言っていません。',
          '在庫には追加していません。在庫に追加したと言わないでください。',
          '買い物候補はレシピの材料から suggest_shopping_items が作ります。',
          '特定の食材を候補に足したい場合は、その材料を含むレシピを作り直す必要があることを伝えてください。',
        ].join('\n')
      : [
          '在庫に追加するかどうかを判断できませんでした。在庫には追加していません。',
          '在庫に入れる場合は「在庫に追加して」、買うものに入れる場合は「買い物候補に入れて」と',
          '言ってもらうよう促してください。',
        ].join('\n');

  return { added: false, reason: decision, message };
}

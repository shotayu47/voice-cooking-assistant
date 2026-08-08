/**
 * What to do when cooking goes wrong (PHASE 7).
 *
 * The model writes the sentence; this table decides the rule. Recovery advice
 * is the one place where a plausible-sounding answer can be actively harmful —
 * "it looks done" about undercooked chicken, or "add water" to smoking oil — so
 * the non-negotiable parts live in code where they are reviewable and
 * testable, exactly like the freshness table in PHASE 1.
 *
 * Pure data and pure functions: no I/O, no model calls.
 */

export type Reversibility =
  /** The dish can be brought back to where it should be. */
  | 'recoverable'
  /** Some of it is saved; something is permanently lost. Say so. */
  | 'partial'
  /** Nothing brings this back. Do not imply otherwise. */
  | 'irreversible';

export type TroublePlay = {
  id: string;
  label: string;
  /** Example phrasings, so the model can map an utterance onto this entry. */
  cues: string[];
  /** The single thing to do right now. Goes first in the reply, always. */
  immediate: string;
  /** How to judge the state, once the immediate action has bought time. */
  checks: string[];
  /** Things that make it worse. These are the ones people reach for anyway. */
  avoid: string[];
  reversibility: Reversibility;
  /**
   * Food-safety or fire rules. Present only where getting it wrong hurts
   * someone. Never softened, never traded off against taste.
   */
  safety?: string;
};

export const TROUBLE_PLAYBOOK: TroublePlay[] = [
  {
    id: 'burning',
    label: '焦げそう・焦げた',
    cues: ['焦げそう', '焦げてる', '焦げ臭い', '黒くなってきた'],
    immediate: '火を止めるか最弱にして、中身を別の器やフライパンに移す',
    checks: [
      '鍋底に張り付いた黒い部分は移さず鍋に残す',
      '焦げていない部分のにおいを確認する。苦いにおいが移っていなければその部分は使える',
    ],
    avoid: [
      '焦げた部分を混ぜ込むこと（苦味が全体に回り、取り返しがつかなくなる）',
      '火にかけたまま原因を考えること',
    ],
    reversibility: 'partial',
  },
  {
    id: 'undercooked',
    label: '生焼け・中まで火が通っていない',
    cues: ['生焼け', '中が赤い', '生っぽい', '火が通ってない'],
    immediate: '食べずに、弱めの中火で蓋をして加熱を続ける',
    checks: [
      '厚みがあるものは一度切って中心の色を見る',
      '肉汁が透明になり、中心まで色が変わっているかを見る',
    ],
    avoid: [
      '表面の焼き色だけで判断すること',
      '強火で表面から追い込むこと（外が焦げて中が生のまま残る）',
    ],
    reversibility: 'recoverable',
    safety:
      '鶏肉・豚肉・ひき肉・魚介は中心まで確実に加熱する。判断がつかない場合は加熱を続ける側に倒す。見た目だけで「大丈夫」と言わない。',
  },
  {
    id: 'over-seasoned',
    label: '塩・調味料を入れすぎた',
    cues: ['しょっぱい', '塩入れすぎた', '味が濃い', '醤油入れすぎ'],
    immediate: '火を止めて、それ以上調味料を足さない',
    checks: [
      '汁物なら水や出汁、具材を足して総量を増やす',
      '炒め物や和え物なら、味のついていない同じ食材を足して薄める',
    ],
    avoid: [
      '砂糖や酢で「打ち消そう」として味を足し続けること（濃さは減らず、味だけ複雑になる）',
      '薄めた直後に味見せず、さらに調味料を足すこと',
    ],
    reversibility: 'partial',
  },
  {
    id: 'watery',
    label: '水っぽい・味が薄い',
    cues: ['水っぽい', '汁が多い', '味が薄い', 'ゆるい'],
    immediate: '蓋を外して中火にし、煮汁を飛ばす',
    checks: ['煮詰めるほど塩味も濃くなるので、味を決めるのは詰め終わってから'],
    avoid: ['先に調味料を足してから煮詰めること（確実にしょっぱくなる）'],
    reversibility: 'recoverable',
  },
  {
    id: 'overcooked',
    label: '固くなった・火を通しすぎた',
    cues: ['固い', 'パサパサ', '煮すぎた', '焼きすぎた'],
    immediate: 'それ以上加熱しない。火から下ろす',
    checks: [
      '肉が固いなら繊維を断つ方向に薄く切る',
      '煮込みや汁物に転用すると、水分を含ませて食べやすくできる場合がある',
    ],
    avoid: ['固いからと強火で追加加熱すること（さらに水分が抜けて固くなる）'],
    reversibility: 'partial',
  },
  {
    id: 'sticking',
    label: 'くっつく・こびりつく',
    cues: ['くっつく', 'こびりついた', '剥がれない', '張り付いた'],
    immediate: '無理に剥がさず、火を弱めて30秒ほど待つ',
    checks: [
      '焼き色が十分についたタンパク質は自然に離れる。触らない時間が要る',
      '次に焼くときはフライパンを十分に予熱してから油を引く',
    ],
    avoid: ['固まる前に何度も動かすこと', '金属のヘラで削り取ろうとすること'],
    reversibility: 'recoverable',
  },
  {
    id: 'wrong-order',
    label: '入れる順番・材料を間違えた',
    cues: ['間違えて入れた', '順番間違えた', '先に入れちゃった'],
    immediate: '火を止めて、今の状態を確認する',
    checks: [
      '取り出せるものは取り出す（固形で、まだ混ざっていないもの）',
      '取り出せないなら、残りの工程の加熱時間や調味料でつじつまを合わせられるか考える',
    ],
    avoid: ['慌てて次の工程に進むこと（間違いが固定される）'],
    reversibility: 'partial',
  },
  {
    id: 'boiling-over',
    label: '吹きこぼれそう',
    cues: ['吹きこぼれる', '泡が上がってきた', 'あふれそう'],
    immediate: '火を弱めて、蓋をずらして隙間を作る',
    checks: ['泡が引いたら火加減を戻す'],
    avoid: ['蓋を閉めたまま強火を続けること'],
    reversibility: 'recoverable',
  },
  {
    id: 'oil-smoking',
    label: '油から煙・油はね',
    cues: ['煙が出てる', '油がはねる', '油から煙'],
    immediate: '火を止める',
    checks: ['煙が収まってから、油の温度が下がったか確認する'],
    avoid: ['熱くなった油に水を入れること', '煙が出たまま食材を投入すること'],
    reversibility: 'irreversible',
    safety:
      '油に火がついた場合は、絶対に水をかけない。可能なら蓋をして酸素を断ち、火元を止める。手に負えないと感じたらすぐ避難して119番に連絡する。アシスタントが消火を指示して引き延ばさない。',
  },
];

export function findTroublePlay(id: string): TroublePlay | null {
  return TROUBLE_PLAYBOOK.find((play) => play.id === id) ?? null;
}

/** The entries where being wrong hurts someone rather than the dish. */
export function safetyCriticalPlays(): TroublePlay[] {
  return TROUBLE_PLAYBOOK.filter((play) => play.safety !== undefined);
}

const REVERSIBILITY_LABEL: Record<Reversibility, string> = {
  recoverable: '元に戻せる',
  partial: '一部だけ救える（失われる部分は正直に伝える）',
  irreversible: '元に戻せない',
};

/**
 * Renders the playbook for the system prompt.
 *
 * Only injected while a cooking session is open — it is dead weight in every
 * other turn, and the prompt is rebuilt on each one.
 */
export function renderTroublePlaybook(): string {
  const entries = TROUBLE_PLAYBOOK.map((play) => {
    const lines = [
      `■ ${play.label}（例: ${play.cues.join(' / ')}）`,
      `  今すぐ: ${play.immediate}`,
      `  確認: ${play.checks.join(' / ')}`,
      `  してはいけない: ${play.avoid.join(' / ')}`,
      `  見通し: ${REVERSIBILITY_LABEL[play.reversibility]}`,
    ];
    if (play.safety) {
      lines.push(`  安全（最優先・例外なし）: ${play.safety}`);
    }
    return lines.join('\n');
  });

  return ['【トラブル対応表】', ...entries].join('\n');
}

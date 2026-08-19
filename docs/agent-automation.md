# エージェント自動化ガイド

`agent-ready` ラベルを Issue に付けると、Claude Code が自動着手する仕組みの
概要。運用中の自動化を短時間で把握するための資料であり、ワークフロー定義の
正本は `.github/workflows/claude-agent-ready.yml` と `.github/workflows/ci.yml`。

## 起動条件

Open 状態の Issue に **`agent-ready` ラベルを付ける**と、
`.github/workflows/claude-agent-ready.yml` が Claude Code を起動する。
Issue が Open でない場合や別ラベルの場合は起動しない。

## Claude が着手前に読むもの

Claude はコードを変更する前に、リポジトリの以下のファイルを読む:

- `AGENTS.md`
- `CLAUDE.md`
- `docs/implementation-roadmap.md`

ラベル付き Issue の本文がタスク仕様そのものとして扱われる。指示されていない
変更（アプリケーションコード、`.github/workflows/*`、ロードマップの PHASE
ステータスなど）は行わない。

## 実装〜push

Claude は専用ブランチ上で作業し、要求された変更を行ったうえで
コミットし、そのブランチを push する。品質ゲート（typecheck / lint /
test / build）はここでは実行しない — それらは PR 作成後の CI が担当する。

## PR 作成と CI 起動

Claude が変更を push すると、ワークフローが自動的に:

1. push されたブランチと `main` の差分を確認する
2. 差分があれば Pull Request を作成する（Issue 番号を本文に記載）
3. 作成した PR に対して `ci.yml`（typecheck / lint / test / build）を
   明示的に dispatch する

## 人間が担う範囲

- **マージは常に手動。** ワークフローは PR を作成するだけで、マージは行わない。
- **実機・手動 QA は人間の責任のまま。** CI が確認するのは typecheck / lint /
  test / build のみで、実際のデバイスでの動作確認や UX の妥当性は含まれない。

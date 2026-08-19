# エージェント駆動の開発フロー

このドキュメントは、GitHub Issue のラベル付けから Claude Code が自動的にコードを
変更し、Pull Request が作られるまでの現在の自動化フローを説明する。
ワークフロー定義そのもの（`.github/workflows/*`）が正であり、ここは人間向けの要約。

## トリガー：`agent-ready` ラベル

Issue に **`agent-ready` ラベル**を付けると、`.github/workflows/claude-agent-ready.yml`
が `issues: labeled` イベントで起動し、Claude Code がその Issue に着手する
（対象は open な Issue のみ）。

これとは別に `.github/workflows/claude.yml` があり、Issue コメントや PR レビュー
コメント中の `@claude` メンション、および本文か件名に `@claude` を含む新規 Issue でも
Claude Code が起動する。ただしこちらは Pull Request の自動作成は行わない
（コード変更・commit・push までが範囲）。

## 着手前に読むファイル

Claude はコードを変更する前に、システムプロンプトの指示に従って以下を読む：

- `AGENTS.md` — リポジトリ全体のエージェント向けルール
- `CLAUDE.md` — `AGENTS.md` を読み込む形で同じ内容を提供
- `docs/implementation-roadmap.md` — 長期実装の進捗（PHASE の状態）の source of truth

これにより、すでに `COMPLETE` になっている PHASE を作り直したり、ロードマップの
運用ルール（1 PHASE = 実装→テスト→ロードマップ更新→commit→push）に反する変更を
しないようにしている。

## 作業ブランチと commit / push

Claude は Issue ごとに**自分専用のブランチ**（`claude/issue-<番号>-...` の形式）で
作業する。既存ブランチへの直接 push ではなく、Issue から起動した場合は新しいブランチを
作成する。変更が必要な場合は、要求された範囲だけを変更し、リポジトリの品質ゲート
（`npm run typecheck` / `npm run lint` / `npm test` など、必要に応じて
`npm run build` / `npm run check:migrations` / `npm run audit:rls`）を実行したうえで
commit し、ブランチを push する。

`claude-agent-ready.yml` のワークフローには以下の制約がある：

- 変更してよいツールは `--allowedTools` で明示された範囲に限定される
  （`Edit` / `Write` / `npm ci` / `npm run typecheck` / `npm run lint` / `npm test` /
  `npm run build` / `npm run check:migrations` / `npm run audit:rls`）
- `.github/workflows/*` は変更しない
- シークレットは変更・開示しない
- ブランチの merge は行わない
- テスト・migration・デプロイ・手動検証について、実際に確認していないことを
  「成功した」と主張しない
- 外部サービスや人手が必要な手順がある場合は、推測せずそのまま報告する

## Pull Request の自動作成と CI の明示的な dispatch

Claude がブランチへ変更を push すると、`claude-agent-ready.yml` のワークフローが
続けて以下を行う：

1. push されたブランチと `main` を比較し、実際に差分がある場合のみ処理を続ける
2. 同じブランチに対する open な PR がまだ無ければ、`main` を base にした
   Pull Request を自動作成する（タイトルは Issue タイトル、本文に元 Issue への
   参照を含む）
3. PR 作成後、`gh workflow run ci.yml --ref <branch>` で **CI を明示的に dispatch** する
   （`ci.yml` は通常 `pull_request` イベントでも動くが、Issue 起点のこのフローでは
   確実に走らせるために明示的にトリガーしている）

`ci.yml` は typecheck → lint → test → build を実行する。

## Merge は手動のまま

**この自動化は Pull Request の作成までであり、`main` への merge は自動化されていない。**
作成された PR は人間がレビューし、手動で merge判断を行う必要がある。
Claude Code がブランチを merge することはない。

## 実機・手動 QA は人間の責任のまま

このフローが検証できるのは typecheck / lint / unit test / build までであり、
iPhone 実機や Vercel Preview 上での動作確認（実機 QA）は自動化されていない。
`docs/implementation-roadmap.md` の各 PHASE 記録にあるとおり、実機での見た目・
操作性・通知動作などの確認は、引き続き人間が行う必要がある。

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `.github/workflows/claude-agent-ready.yml` | `agent-ready` ラベルをトリガーに Claude Code を実行し、PR 作成・CI dispatch まで行う |
| `.github/workflows/claude.yml` | `@claude` メンションをトリガーに Claude Code を実行する（PR 自動作成なし） |
| `.github/workflows/ci.yml` | typecheck / lint / test / build を実行する CI |
| `AGENTS.md` / `CLAUDE.md` | Claude が着手前に読むリポジトリ全体のルール |
| `docs/implementation-roadmap.md` | 実装状況の source of truth |

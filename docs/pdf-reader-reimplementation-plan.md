# Rill PDF Reader 統合計画

> **Rill 0.8.0 の実装について** これは開発時の計画記録である。Rill
> 0.8.0 は、Zotero Reader の表示UIを使用せず、AGPLv3に基づいてその一部を
> 改変したPDF文字選択エンジンを同梱する。画面、Reading Notes、注釈管理、
> Markdown保存はRill側の実装である。

## 完成条件

Rill の見た目とワークフローを保ったまま、次を満たす。

- 二段組みの左段下部から右段上部へ自然に選択できる
- 右段上部から左段下部への逆方向選択も同じ文章になる
- スクロール、ズーム、見開き切替で選択が消えない
- 選択表示と Reading Notes の引用文が一致する
- 削除、色変更、下線変換が中央表示と右メモへ同時に反映される
- PDF 内検索、目次、サムネイル、見開き表示が Rill UI から操作できる
- 注釈はローカル JSON と Markdown へ原子的に保存される
- Obsidian の変更と安全に三方向マージできる

## フェーズ 0: 解析基準を固定

- upstream commit を固定する
- Reader Lab の DMG、ソース commit、第三者ライセンスを対応付ける
- 病的 PDF を含む非公開ローカル fixture 一覧を作る
- テスト用 PDF や論文本文を GitHub へコミットしない

完了判定: 同じソースから同じ lab app を再生成できる。

## フェーズ 1: エンジン adapter

`RillPdfReader.tsx` は upstream private API へ直接アクセスせず、`RillPdfEngine` adapter だけを利用する。

対象コマンド:

- open / close
- page navigation
- zoom
- spread / scroll mode
- search
- tool selection
- annotation snapshot
- annotation add / update / delete
- selection finalized
- document stats

イベントには必ず単調増加する revision を付ける。古い非同期 save callback が新しい UI state を上書きしないようにする。

完了判定: React component に `_primaryView`、`_render`、Reader 内部 state 名が出現しない。

## フェーズ 2: 単一の注釈ストア

Rill 側に `AnnotationRepository` を設ける。

```text
User action
  -> engine command
  -> Reader event
  -> AnnotationRepository transaction
  -> React snapshot
  -> JSON atomic write
  -> Markdown projection
```

注釈削除では、次を一つの transaction とする。

1. engine から overlay を除外
2. selected annotation を解除
3. Rill store から除外
4. 右メモを更新
5. JSON を一時ファイル経由で rename
6. Markdown の Highlights section を更新

保存失敗時は UI に失敗を示し、メモリ上の revision とディスク revision を区別する。

完了判定: 削除後、中央 overlay、右メモ、再起動後の三者が一致する。

## フェーズ 3: Rill 固有の選択 UI

upstream selection popup を表示せず、選択確定 event を受けて Rill の popup を描く。

- ハイライト
- 下線
- 取り消し線
- 色
- メモに追加
- コピー

取り消し線は Reader の基礎 annotation model を拡張するか、Rill adapter 上の独自 type として保持する。upstream type へ無理に偽装しない。

完了判定: Zotero 固有のラベル、アイコン、レイアウトが画面に出ず、Rill の操作感だけになる。

## フェーズ 4: 読み順強化

まず Zotero の structured chars をそのまま基準にする。その上で feature flag `rillReadingOrderV2` を作る。

### V2 パイプライン

1. StructuredChar から Line を作る
2. 重複行、ヘッダー、フッター、ページ番号を除外
3. 全幅領域と列領域を分離
4. column gap をクラスタリング
5. Line を TextBlock へ結合
6. font / indent / spacing / punctuation から段落を推定
7. block graph を topological sort
8. 元ストリーム順との edit distance を測り、信頼度を付ける

低信頼度 PDF では自動並べ替えを使わず、元順を維持する。

完了判定: fixture の二段組みで、表示範囲と引用テキストの順序が一致する。

## フェーズ 5: 検索・目次・サムネイル

### 検索

- StructuredChar の文字列と offset mapping を利用
- current / all match を Rill overlay へ描画
- Enter / Shift+Enter と上下ボタンに対応

### 目次

- native outline を優先
- 無い場合の推定 outline は「自動生成」と表示
- 推定結果をユーザーデータへ勝手に保存しない

### サムネイル

- 可視範囲を優先する一列 queue
- HiDPI render -> 段階縮小
- 注釈変更時は描画済みページだけ invalidate

完了判定: 100 ページ以上の PDF でも最初の表示を妨げず、スクロールに応じて遅延描画される。

## フェーズ 6: 注釈拡張

- ハイライト
- 下線
- 取り消し線
- 範囲画像
- 付箋
- 色の後変更
- 範囲端の調整
- undo / redo

注釈座標は PDF coordinate で保存する。CSS pixel や現在の zoom を保存しない。

範囲画像は画像データを Markdown へ base64 で埋めず、Rill library の attachment file として保存し相対リンクする。

完了判定: zoom 変更、回転、再起動後にも位置と画像が一致する。

## フェーズ 7: Markdown / Obsidian

注釈 JSON を正本、Markdown の Highlights section を投影とする。

- Rill 管理 section に安定 ID を埋める
- Rill base、disk current、Rill next の三方向マージ
- ユーザーが section 外へ書いた文章を保持
- 同じ注釈コメントが双方で変わったときだけ conflict UI を出す
- atomic write と backup generation を使う

完了判定: Obsidian と Rill で同じノートを交互に編集しても、ユーザー文章が失われない。

## テストマトリクス

### 文字と段組み

- 一段組み
- 二段組み 左下 -> 右上
- 二段組み 右上 -> 左下
- 三段組み
- 全幅見出し + 二段本文
- 本文途中の全幅図表
- 脚注
- ヘッダー / フッター / DOI / ページ番号
- キャプションと本文が隣接

### 文字エンコーディング

- `fi` / `fl` 合字
- combining marks
- ハイフネーション
- OCR の一行一段落
- 透明文字の重複
- CJK
- RTL
- 縦書き
- 90 / 180 / 270 度回転文字
- Type 3 font

### 操作

- 正方向 / 逆方向ドラッグ
- ダブルクリック単語選択
- トリプルクリック行選択
- Shift + click
- Shift + arrow
- 選択中の上下スクロール
- ページをまたぐ選択
- zoom 中の選択
- 見開き中の選択
- 選択直後の色変更
- 注釈削除後の再起動

### 品質判定

各 fixture で次を保存する。

- expected text
- expected ordered line IDs
- expected page / rect count
- expected excluded regions
- forward / reverse の一致

画像 snapshot だけでなく、文字列と rect の構造 assertion を必須にする。

## 既知の制約

- PDF に正しい文字マッピングが無い場合、OCR なしでは復元できない。
- 複雑な表は「読む順序」が一意ではない。
- 数式、脚注、サイドバーは文書ごとの意味推定が必要になる。
- 三ページ以上を一件の注釈として扱う形式は Rill 側で拡張が必要。
- upstream 更新時には fork の `getPageData()` 契約を回帰テストする必要がある。

## リリースゲート

Reader Lab から main へ入れる条件は次の通り。

1. Rill UI のまま動く。
2. 代表 fixture の選択順テストがすべて通る。
3. 削除と色変更の state divergence がない。
4. JSON / Markdown の再起動 round trip が通る。
5. AGPL / third-party notice と対応ソース URL が DMG から確認できる。
6. upstream private API を UI component が直接呼ばない。

# Zotero Reader / PDF.js エンジン解析ノート

> **Rill 0.8.0 の実装について** これは開発時の分析記録である。Rill
> 0.8.0 は、Zotero Reader の表示UIを使用せず、AGPLv3に基づいてその一部を
> 改変したPDF文字選択エンジンを同梱する。画面、Reading Notes、注釈管理、
> Markdown保存はRill側の実装である。

## 目的

Rill 0.7.8 の画面構成、色、Reading Notes、ローカル保存方式を維持しつつ、Zotero Reader の優れた文字選択と注釈操作を再現できるように、実装を機能単位へ分解する。

この文書でいう「再現」は、Zotero の画面や商標を複製することではない。公開ソースの挙動とデータフローを解析し、Rill の UI と保存モデルへ接続することを指す。

解析対象は次のリビジョンで固定する。

- Zotero Reader: `c12c65e3f01414ae244f6102da4028c700cf6584`
- Zotero PDF.js fork: `f57fc80d1c07e4cdc50a767ae0b500b5272123b4`
- Rill PDF Viewer Lab: `codex/rill-zotero-reader-lab`

## 結論

Zotero の文字選択が優れている理由は、単に PDF.js を使っているからではない。

1. PDF.js のワーカー側で、グリフごとの文字、矩形、ベースライン、回転、フォント情報を抽出する。
2. Zotero の PDF.js fork が文字を行・単語・段落へ構造化し、安定した文字オフセットを付ける。
3. Reader がポインタ座標を文字オフセットへ変換し、ブラウザの DOM Range とは別の選択モデルを持つ。
4. ドラッグ中の表示は、構造化文字から生成した行矩形を独自オーバーレイとして描く。
5. 選択確定後だけ DOM の選択範囲を同期し、コピーとアクセシビリティに利用する。
6. 注釈は文字オフセットから得た PDF 座標で保持し、ズームや再描画後も同じ位置に復元する。

つまり、重要なのは「文字抽出」「構造化」「論理選択」「表示」「永続化」を分離している点である。

## 全体アーキテクチャ

```text
PDF bytes
  -> PDF.js worker / evaluator
      -> glyph extraction
      -> char geometry
  -> Zotero PDF.js module
      -> structured chars
      -> content region / isolated text
      -> links / citations / outline / page labels
  -> Reader PDFView
      -> pointer-to-PDF coordinates
      -> char-offset selection ranges
      -> custom selection overlay
      -> annotation commands
  -> AnnotationManager
      -> canonical in-memory state
      -> undo / redo
      -> debounced save / delete callbacks
  -> Host application
      -> annotation JSON
      -> Markdown notes
      -> Rill UI
```

## 1. PDF 文字抽出層

主な実装:

- `pdf.js/src/core/evaluator.js`
- `pdf.js/src/core/module/module.js`
- `pdf.js/src/core/worker.js`
- `pdf.js/src/display/api.js`

### グリフから作られる文字データ

Zotero fork は通常の `textContent.items[].str` に加え、各 item に `chars` を持たせる。各文字には概ね次の情報が入る。

```ts
type RawChar = {
  c: string;          // NFKDを使った表示・検索向け文字
  u: string;          // 元のUnicodeをなるべく保持した文字
  rect: [number, number, number, number];
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  glyphWidth: number;
  baseline: number;
  rotation: 0 | 90 | 180 | 270;
  diagonal: boolean;
};
```

矩形は PDF の current transformation matrix と文字の ascent / descent / advance から計算される。Type 3 フォントと縦書きにも個別処理がある。制御文字は除外し、合字や結合文字は正規化される。

`Module.getPageData({ pageIndex })` は最終的に次を返す。

```ts
type PageData = {
  partial: true;
  chars: StructuredChar[];
  overlays: Overlay[];
  viewBox: [number, number, number, number];
};
```

この API が標準 PDF.js と Zotero Reader の間に追加された重要な境界である。

## 2. 文字構造化層

主な実装:

- `pdf.js/src/core/module/structure.js`
- `getStructuredChars()`
- `split()`

### 重複除去

OCR や印刷用 PDF では、同じ文字レイヤーが複数回含まれる場合がある。`文字 + rect` の fingerprint で同一文字を除外する。

### 行の認識

隣接文字について次を評価し、行の境界を作る。

- ベースライン差
- 文字の進行方向が行頭へ戻ったか
- 回転方向の変化
- 矩形が同じ行方向に重なるか
- drop cap のような極端な文字高

同じ行に入った文字は、回転方向に応じた視覚座標で並べ直され、bidi 処理を通る。

### 単語の認識

Xpdf 由来の適応的な spacing threshold を使う。固定ピクセルではなく、平均フォントサイズ、隣接文字間隔、明示的スペースの分布から閾値を求める。

結果として各文字に次のフラグが付く。

- `wordBreakAfter`
- `spaceAfter`
- `lineBreakAfter`
- `paragraphBreakAfter`

### 段落の認識

行間、行高、主要フォント、インデント、上下関係を見て段落境界を推定する。インデントによる境界は保持し、偶発的な一行段落は前段落へ戻す。

### ハイフネーション

行末の dash / hyphen は `ignorable` として扱い、引用テキストでは単語を不自然に分断しない。

### 行矩形

各文字の `rect` とは別に `inlineRect` を作る。同一行の文字は共通の行高を持つため、ハイライトの一行目だけ高さや色面積が違う問題を避けられる。

### 安定オフセット

構造化後に `offset` を 0 から順に付ける。このオフセットが、選択、検索、注釈、コピーの共通キーになる。

## 3. 読み順の実態

重要な注意点として、`structure.js` は同じ行の文字を視覚順へ並べ直すが、ページ全体の行を幾何学的に列分割して全面的に並べ直してはいない。

二段組みが正しく選べる PDF では、主に次の組み合わせで品質が出ている。

- PDF のコンテンツストリーム自体が本文の読み順に近い
- 行・段落境界が文字配列に付いている
- 選択が DOM 上の矩形横断ではなく、文字オフセットの連続範囲として進む
- ヘッダー、フッター等を isolated text として本文選択から外す

したがって Zotero でも、元 PDF の文字ストリーム順が壊れている場合に万能ではない。Rill でさらに安定させるには、列と本文ブロックから reading-order graph を作る補助層を追加する価値がある。

## 4. 本文領域と isolated text

主な実装:

- `pdf.js/src/core/module/content-rect.js`
- `Module.getProcessedData()`
- Reader `applySelectionRangeIsolation()`

前後ページの同じ高さに現れる類似行を比較し、繰り返しヘッダーやフッターを推定する。ページ番号も候補から外し、残った本文行の bounding rect を本文領域とする。

本文領域外の文字には `isolated = true` が付く。選択開始点が本文なら isolated 文字を除外し、開始点がヘッダー等なら本文を除外する。これにより、二段組み選択が DOI、誌名、ページ番号へ飛ぶ症状を抑える。

## 5. 選択モデル

主な実装:

- `reader/src/pdf/selection.js`
- `reader/src/pdf/pdf-view.js`

### 座標から文字オフセットへ

ポインタを PDF 座標へ変換し、全文字の矩形との距離から最寄り文字を求める。文字の中心より前後どちらにいるかと回転方向を見て、caret が文字の前か後かを決める。

### SelectionRange

```ts
type SelectionRange = {
  anchorOffset: number;
  headOffset: number;
  anchor?: boolean;
  head?: boolean;
  collapsed?: boolean;
  position: {
    pageIndex: number;
    rects: PdfRect[];
  };
  text: string;
  sortIndex?: string;
};
```

選択は `anchorOffset` と `headOffset` を正本とする。ドラッグ方向を反転しても同じモデルで扱える。

### 行矩形への変換

選択範囲の文字を `lineBreakAfter` ごとにまとめ、`inlineRect` を union して一行一矩形にする。ハイライトが右余白まで伸びることを防ぎ、行ごとの高さも揃う。

### 単語・行・キーボード選択

- ダブルクリック: `wordBreakAfter` まで拡張
- トリプルクリック: `lineBreakAfter` まで拡張
- Shift + 矢印: 文字オフセットを変更
- 上下キー: 隣接行の最も近い文字へ移動
- Shift + クリック: 既存 anchor を維持して head を更新

### 複数ページ

ページごとに SelectionRange を持つ。注釈形式は `position.rects` と `position.nextPageRects` に正規化され、現在はテキスト注釈として隣接二ページまでを一件にまとめる。

## 6. なぜページ全体が青くならないか

Reader はドラッグ中にブラウザ標準選択を正本にしない。

- `pdf-view.js` が capture phase で pointer / mouse event を処理する
- `_selectionRanges` を更新する
- `page.js` が選択矩形を custom annotation layer に描く
- `viewer.css` の通常 `::selection` は透明
- 選択確定時に `setTextLayerSelection()` で DOM Range を同期する

DOM Range はコピーとアクセシビリティの補助であり、画面上の選択形状を決めるものではない。

## 7. 注釈描画

主な実装:

- `reader/src/pdf/page.js`
- `reader/src/pdf/lib/utilities.js`

PDF キャンバスは汚さず、その上の DOM overlay に display list を描く。

- highlight: 行矩形 + `mix-blend-mode: multiply`
- underline: 文字回転に応じて行端へ細線を置く
- note: SVG の付箋アイコン
- image: 矩形範囲
- ink: path
- find result: 検索結果矩形
- current selection: 独立した selection color

ページ座標を表示座標へ毎回変換するので、ズーム、回転、見開き、再描画後も注釈位置が維持される。

## 8. 注釈状態と保存

主な実装:

- `reader/src/common/annotation-manager.js`
- `reader/src/common/reader.js`

`AnnotationManager` が注釈の唯一の正本である。

- add / update / delete
- 色変更
- highlight と underline の相互変換
- sortIndex 順の整列
- undo / redo
- client から来た `setAnnotations` / `unsetAnnotations`
- 1 秒 debounce、最大 10 秒で host callback へ保存

削除では、まずメモリ上の注釈を null change として適用して即時再描画し、その後 host の delete callback を呼ぶ。

Rill では Reader と React の両方を正本にすると削除や色変更が片側だけ残る。Rill の adapter でコマンドを一方向に流し、Reader の callback から返った確定状態を Rill store と JSON / Markdown へ反映する必要がある。

## 9. PDF 内検索

主な実装:

- `reader/src/pdf/pdf-find-controller.js`

各ページの `StructuredChar.u` を連結し、検索用に Unicode 正規化する。同時に検索文字位置から元の文字オフセットへ戻す mapping を作る。

検索一致は文字オフセットから `getRangeRects()` で PDF 矩形へ戻される。したがって検索結果の表示と本文選択が同じ座標系になる。

対応要素:

- 大文字小文字
- 単語単位
- 全件ハイライト
- 前後移動
- CJK の文字種
- ダイアクリティカルマークと NFKC 系正規化

## 10. 目次、ページ番号、リンク

### 目次

まず PDF 内蔵 outline を読む。無い場合は、本文の主要フォントと異なる見出し候補、サイズ、連番、出現範囲を用いて最大 100 ページから outline を推定する。

### ページラベル

PDF metadata の page labels を優先し、必要に応じて前後ページの同じ位置に並ぶアラビア数字またはローマ数字の連続列から印刷ページ番号を推定する。

### リンクと引用

通常リンクに加え、本文中引用と参考文献候補を processed overlay として抽出する。Rill の初期段階では通常リンクだけを採用し、引用リンク解析は独立した後続機能にできる。

## 11. サムネイルと見開き

サムネイルは専用の一列 queue で必要ページだけを遅延描画する。HiDPI で二倍程度に描いて段階的に縮小し、ぼやけを抑える。既に表示済みのサムネイルだけを注釈変更時に再描画する。

見開きとスクロールモードは PDF.js event bus の `switchspreadmode` / `switchscrollmode` を利用する。Rill UI はこの公開 adapter だけを呼べばよい。

## 12. 自動スクロール

選択中にポインタが viewer の端 25 px を越えると、距離に比例して最大 500 px/s で requestAnimationFrame スクロールする。選択状態は文字オフセットとして保持されるため、スクロールしても消えない。

## 13. Rill に採用する境界

当面は、Zotero Reader / PDF.js fork を AGPL エンジンとして隔離し、Rill UI とは型付き adapter で接続するのが最も安全である。

```ts
interface RillPdfEngine {
  open(input: ArrayBuffer): Promise<DocumentInfo>;
  navigate(target: PageTarget | AnnotationTarget): Promise<void>;
  setZoom(command: "in" | "out" | "page-width"): void;
  setSpread(mode: "none" | "odd" | "even"): void;
  setTool(tool: RillTool): void;
  setAnnotations(snapshot: RillAnnotation[]): void;
  deleteAnnotations(ids: string[]): void;
  search(query: SearchQuery): AsyncIterable<SearchState>;
  subscribe(listener: (event: ReaderEvent) => void): () => void;
  destroy(): void;
}
```

React から `_primaryView` や `_render()` のような private API を直接触らない。adapter 内部だけが upstream API 差分を吸収する。

## 14. Rill 側の推奨モジュール

```text
reader-engine/
  document-adapter.ts
  page-data.ts
  selection-model.ts
  annotation-model.ts
  search-adapter.ts
  reader-events.ts
  zotero-engine-adapter.ts

reader-ui/
  RillReaderShell.tsx
  RillReaderToolbar.tsx
  RillNavigation.tsx
  RillPdfSurface.tsx
  RillSelectionMenu.tsx
  RillReadingNotes.tsx

reader-storage/
  annotation-repository.ts
  markdown-projection.ts
  obsidian-merge.ts
```

## 15. 追加する Rill reading-order 層

元 PDF の文字順が壊れている文書を改善するため、Zotero の構造化文字の後段に任意の補助層を置く。

1. 行矩形を生成する。
2. 横方向の空白帯から列を推定する。
3. 全幅見出し、本文列、脚注、キャプションを block に分類する。
4. block 間に「次に読む」有向辺を作る。
5. PDF content stream 順と幾何順の差が小さい場合は元順を優先する。
6. 信頼度が低い場合は並べ替えず、ユーザーが範囲を修正できるようにする。

この層は Zotero の挙動を壊さないよう feature flag で導入する。

## 16. ライセンス境界

Zotero Reader は GNU AGPLv3、Zotero の PDF.js fork には Mozilla / Apache 系を含む複数の第三者ライセンスがある。

Rill PDF Viewer Lab で実コードを組み込んで配布する場合は、少なくとも次を守る。

- 対応するソースを利用者へ提供する
- AGPLv3 の COPYING と著作権表示を同梱する
- 第三者 NOTICE / LICENSE を維持する
- 改変箇所を明示する
- Zotero の名称、ロゴ、画面を Rill のブランドとして使わない
- 配布 DMG と対応する commit / tag を紐付ける

無料配布か有料配布かは、AGPL の遵守要否を変えない。寄付を受け取ること自体は問題にならないが、配布物の自由を制限しない。

## 17. 現在の Reader Lab で分かった統合上の問題

- Rill React state と Reader AnnotationManager の二重管理がある。
- 削除時に private API を複数回呼んでおり、中央 overlay と右メモの状態が一時的にずれる。
- Rill toolbar から一部機能が Reader private view へ直接到達している。
- upstream の selection popup を CSS で隠す・並べ替える方式は壊れやすい。
- `nextPageRects` は二ページまでなので、三ページ以上の連続注釈方針を Rill 側で定義する必要がある。

解決方針は、Reader を headless に近い engine として扱い、選択確定・注釈追加・注釈変更・注釈削除を `ReaderEvent` として Rill へ一本化することである。

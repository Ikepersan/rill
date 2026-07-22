# Rillを別のMacで再開するための引継ぎ仕様書

最終更新日は2026年7月22日です。

この文書は、現在のRill macOS版の開発状態を別のMacへ復元し、同じ地点から作業を再開するための基準です。

## 1. 現在の正本

**ソースコードの正本**は、次のGitリポジトリ、ブランチ、コミットです。

- GitHub: `https://github.com/Ikepersan/rill.git`
- 作業ブランチ: `codex/macos-release-0.8.0`
- この文書作成前の実装基準コミット: `a0109ba Set current Rill preview version to 0.8.0`
- 現在のバージョン: `0.8.0`
- 現在のMac上のworktree: `/Users/user/Documents/文献管理アプリ/.worktrees/macos-release-0.8.0`
- `master`の現在位置: `cf163b4 Release Rill 0.7.11`

worktreeのパスは現在のMacだけの作業場所であり、別のMacへは引き継がれません。

別のMacでは、必ずGitブランチ `codex/macos-release-0.8.0` とコミット `a0109ba` を基準に復元します。

このブランチには、CSLエディター、Referencesの並べ替え、引用レイアウト、Libraryの一括参考操作、読書状態のアクセシビリティ改善、macOS配布準備が統合されています。

直近の主要コミットは次のとおりです。

```text
a0109ba Set current Rill preview version to 0.8.0
bcefd83 Improve reading status accessibility
17f998e Prepare Rill 1.0.0 macOS release
59f456b Format initials before family names
9e0845d Improve citation layout and reference dragging
a589284 Fix citation output consistency
63dc21e Add bulk reference actions to library
22342cb Compact paper drag preview
```

`17f998e`のコミット名には`1.0.0`が残っていますが、その後の`a0109ba`で開発プレビューを`0.8.0`へ戻しています。

## 2. GitHubへの反映状態

`codex/macos-release-0.8.0`は、2026年7月22日にGitHubへpushし、リモート追跡先を設定しました。

公開準備コミットは`5ce1d89 Prepare Rill 0.8.0 source release`です。

リポジトリは現在Privateなので、別のMacから取得するには`Ikepersan`としてGitHubへログインする必要があります。

取得確認には次を使用します。

```sh
git ls-remote --heads origin codex/macos-release-0.8.0
```

一般向けの対応ソースとして公開するには、公開前監査を終えた後でリポジトリをPublicへ変更し、最終コミットへ`v0.8.0`タグを付けます。

`master`へ統合する必要はありません。

正式公開前の調整は、引き続き`codex/macos-release-0.8.0`で行います。

## 3. 最後に生成した確認用DMG

最後に生成して確認に使用していたファイルは、次のDMGです。

[確認用 Rill 0.8.0 DMG](/Users/user/Documents/文献管理アプリ/.worktrees/macos-release-0.8.0/src-tauri/target/release/bundle/dmg/Rill_0.8.0_aarch64.dmg)

- ファイル名: `Rill_0.8.0_aarch64.dmg`
- 対象: Apple silicon Mac
- サイズ: `9,429,849 bytes`
- SHA-256: `84f9129fe695d3b5cf8d363f47c95779fb27d31e3c4073666ea77d9324dde942`
- アプリ本体: `src-tauri/target/release/bundle/macos/Rill.app`

このDMGは`src-tauri/target`以下にあるビルド成果物なので、Gitには保存されません。

別のMacでは、ソースコードを復元した後に再ビルドします。

このDMGはad-hoc署名の確認用ビルドであり、インターネット配布用の完成品ではありません。

## 4. 別のMacで必要な開発環境

次の環境を用意します。

- Apple silicon Mac
- macOS
- Xcode本体とCommand Line Tools
- Git
- Node.js `22.13.0`以上
- npm
- Rust stableとCargo
- Apple Developer Programへ登録したApple ID

現在のMacで確認したバージョンは次のとおりです。

```text
macOS 26.5.2
Xcode 26.6
Git 2.50.1
Node.js 24.10.0
npm 11.6.0
rustc 1.97.1
cargo 1.97.1
```

完全に同一のバージョンである必要はありませんが、Node.jsの下限は`package.json`の指定を守ります。

## 5. 別のMacでの復元手順

### 5.1 GitHubから取得する

ブランチをGitHubへpushした後、別のMacで次を実行します。

```sh
mkdir -p "$HOME/Documents"
cd "$HOME/Documents"
git clone https://github.com/Ikepersan/rill.git
cd rill
git fetch origin
git switch --track origin/codex/macos-release-0.8.0
git rev-parse --short HEAD
```

最後の出力が`a0109ba`、またはこの文書を追加した後継コミットであることを確認します。

すでにclone済みの場合は次を実行します。

```sh
cd "/path/to/rill"
git fetch origin
git switch codex/macos-release-0.8.0
git pull --ff-only
```

### 5.2 依存関係を復元する

```sh
npm ci
rustup show
```

`package-lock.json`と`src-tauri/Cargo.lock`はGitに含まれているため、依存関係はこの2ファイルを基準に復元します。

### 5.3 開発版を起動する

```sh
npm run desktop:dev
```

アプリを直接確認する場合は、Web版ではなくTauriのmacOSアプリを使用します。

CSL画面だけをブラウザで確認する補助コマンドは`npm run desktop:frontend:csl`ですが、最終判断は実アプリ上で行います。

### 5.4 確認用DMGを再生成する

```sh
npm run desktop:build
```

成功すると、次に確認用成果物が生成されます。

```text
src-tauri/target/release/bundle/macos/Rill.app
src-tauri/target/release/bundle/dmg/Rill_0.8.0_aarch64.dmg
```

## 6. 再開直後に行う検証

変更前に、次を実行します。

```sh
npm run desktop:frontend:build
npm run lint -- --quiet
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml library::tests
```

DMGを再生成した後は、次も確認します。

```sh
plutil -extract CFBundleShortVersionString raw \
  src-tauri/target/release/bundle/macos/Rill.app/Contents/Info.plist

codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/release/bundle/macos/Rill.app

shasum -a 256 \
  src-tauri/target/release/bundle/dmg/Rill_0.8.0_aarch64.dmg
```

バージョン出力は`0.8.0`である必要があります。

## 7. Gitでは移動しないデータ

Gitで復元できるのはソースコードだけです。

PDF、個人のReading Notes、Obsidian Vault、Rillのライブラリ設定、ローカルの注釈データは別途移動または同期します。

次のデータは意図的にGitから除外されています。

```text
**/.rill/
**/.obsidian/
*.pdf
*.bib
*.ris
*.enw
*.nbib
*.sqlite
*.sqlite3
*.db
Inbox/
Papers/
Notes/
Exports/
```

Google Drive、iCloud Drive、Dropbox、OneDrive、外付けストレージ、通常のローカルフォルダのいずれを使う場合も、別のMacで同期が完了してからRillにライブラリのルートフォルダを選び直します。

PDFや注釈データをGitHubへ追加してはいけません。

患者情報、未公開資料、Apple IDの資格情報、証明書の秘密鍵もGitHubへ追加してはいけません。

## 8. Apple署名とノータライズの現在地

Apple Developer Programへの登録申請は承認済みです。

2026年7月22日の確認時点では、このMacのKeychainに有効なコード署名用identityがなく、`Developer ID Application`証明書はまだ利用可能な状態になっていませんでした。

`RillNotary`という`notarytool`用Keychain profileもまだ作成されていませんでした。

次の作業は、Xcodeの`Settings > Accounts`からTeamを選択し、`Manage Certificates`で`Developer ID Application`証明書を作成することです。

確認コマンドは次のとおりです。

```sh
security find-identity -p codesigning -v
```

証明書を作成した後は、Apple IDのアプリ用パスワードを作り、次の資格情報をKeychainへ保存します。

```sh
xcrun notarytool store-credentials RillNotary \
  --apple-id "APPLE ID" \
  --team-id "TEAM ID" \
  --password "APP-SPECIFIC PASSWORD"
```

Apple ID、Team ID、アプリ用パスワードは文書やGitへ書き込みません。

配布用ビルドは次で実行します。

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR NAME (TEAMID)"
export RILL_NOTARY_PROFILE="RillNotary"
npm run release:macos
```

この処理は、Developer ID署名、DMG生成、Appleへのノータライズ送信、staple、Gatekeeper検証を順番に行います。

詳細は`docs/releasing-macos.md`と`scripts/release-macos.sh`を参照します。

Developer ID証明書を別のMacでも使用する場合は、証明書と秘密鍵をKeychain Accessからパスワード付き`.p12`として安全に書き出し、新しいMacのKeychainへ読み込みます。

`.p12`とそのパスワードはGitHub、チャット、通常のクラウド共有へ置きません。

## 9. バージョン管理の方針

現在は正式公開前なので、バージョンを`0.8.0`とします。

細かな修正と署名済み配布の検証が終わった段階で、最初の正式公開版を`1.0.0`へ上げます。

バージョンを変更する場合は、少なくとも次の3か所を一致させます。

```text
package.json
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
```

変更後は`package-lock.json`と`src-tauri/Cargo.lock`の差分も確認します。

確認用ビルドでは`tauri.conf.json`のad-hoc署名を使用します。

ネット配布用ビルドでは`src-tauri/tauri.release.conf.json`と`scripts/release-macos.sh`を使用します。

## 10. 作業を再開する際のGitルール

作業開始時に必ず次を確認します。

```sh
git status --short --branch
git branch -vv
git log --oneline -8
```

ユーザーのPDF、注釈、ライブラリフォルダ、無関係な未コミット変更を削除または上書きしてはいけません。

`master`、旧PDFリーダー実験ブランチ、Web版ブランチから作業を再開してはいけません。

macOS版の再開地点は`codex/macos-release-0.8.0`です。

CSL専用ブランチ`codex/rill-csl-editor`の主要成果は現在のmacOSブランチへ統合済みなので、通常はCSLブランチへ戻る必要はありません。

Web版はmacOS版の仕様が固まるまで実装を凍結していたため、macOS配布準備と混ぜません。

## 11. Codexへ渡す再開指示

別のMacでCodexを開いたら、次の文章をそのまま渡せます。

```text
Rill macOS版の作業を再開してください。

リポジトリは https://github.com/Ikepersan/rill.git です。
作業ブランチは codex/macos-release-0.8.0 です。
引継ぎ基準のコミットは a0109ba ですが、docs/HANDOFF_TO_ANOTHER_MAC.mdを追加した後継コミットがあれば、そちらを使用してください。
masterは0.7.11なので、masterから作業を始めないでください。

現在の開発プレビューはRill 0.8.0です。
最後の確認用成果物は src-tauri/target/release/bundle/dmg/Rill_0.8.0_aarch64.dmg でした。
これはad-hoc署名の確認用DMGであり、配布用ではありません。

Apple Developer Programは承認済みです。
Developer ID Application証明書とRillNotary profileの状態を読み取り確認し、秘密情報を表示またはGitへ保存しないでください。
配布用ビルドはdocs/releasing-macos.mdとscripts/release-macos.shに従ってください。

最初にgit status、現在のbranch、HEAD、package versionを確認してください。
次にnpm ciを行い、frontend build、lint、cargo check、library testsを実行してください。
その後、Tauriの実アプリを直接起動して動作確認してください。

ユーザーのPDF、.rill、Obsidian Vault、Reading Notes、既存ライブラリデータは変更またはGitへ追加しないでください。
Web版や保存先/OAuthの作業へ脱線せず、macOS版の署名、ノータライズ、DMG配布準備を優先してください。
```

## 12. 引継ぎ完了条件

次をすべて満たした時点で、別のMacへの引継ぎが完了します。

- GitHubから`codex/macos-release-0.8.0`を取得できる。
- 対象コミットとバージョン`0.8.0`を確認できる。
- `npm ci`が成功する。
- frontend build、lint、Cargo check、library testsが成功する。
- TauriのRill.appを起動できる。
- 確認用`Rill_0.8.0_aarch64.dmg`を再生成できる。
- 個人ライブラリを別経路で同期し、Rillから選び直せる。
- 配布する場合は、Developer ID署名、ノータライズ、staple、Gatekeeper検証がすべて成功する。

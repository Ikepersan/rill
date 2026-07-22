# Rill macOS release

Rill 0.8.0の確認用ビルドと、将来の署名済み配布用ビルドを分離する。

## 一度だけ行う準備

1. Apple Developer Programで `Developer ID Application` 証明書を作成し、Keychainへ登録する。
2. `security find-identity -p codesigning -v` で、証明書名とTeam IDを確認する。
3. ノータライズ資格情報をKeychainへ保存する。

```sh
xcrun notarytool store-credentials RillNotary \
  --apple-id "APPLE ID" \
  --team-id "TEAM ID" \
  --password "APP-SPECIFIC PASSWORD"
```

パスワードや秘密鍵はリポジトリへ保存しない。

## 配布用ビルド

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR NAME (TEAMID)"
export RILL_NOTARY_PROFILE="RillNotary"
npm run release:macos
```

この処理は、Developer ID署名、DMG生成、`notarytool submit --wait`、`stapler staple`、Gatekeeper検証を順番に行う。証明書が見つからない場合は、ad-hoc DMGを配布物として生成せず停止する。

プロジェクトのパスに日本語が含まれていても`stapler`がDMGを見失わないよう、ノータライズ工程ではDMGを一時的な英数字パスへ退避し、検証済みのDMGだけを元の成果物パスへ戻す。

## ローカル開発ビルド

```sh
npm run desktop:build
```

通常ビルドは `tauri.conf.json` のad-hoc署名を使用する。これは開発確認専用であり、ネット配布には使用しない。

## バージョン

現在の開発プレビューは `0.8.0` とし、細かな修正と配布検証を終えた段階で最初の正式公開版 `1.0.0` へ上げる。`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` の3か所を同じ値に保つ。リリース用worktree／ブランチも `macos-release-0.8.0` 系の名前に揃える。

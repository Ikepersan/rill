# Rill macOS release

Rill 1.0.0のローカル確認用ビルドと、署名済み配布用ビルドを分離する。

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

現在の正式公開候補は `1.0.0` とする。`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` の3か所を同じ値に保ち、公開タグは署名・ノータライズ・実アプリ検証がすべて通った最終コミットへ付ける。

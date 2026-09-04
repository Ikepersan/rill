# Rill macOS distribution

Rill 1.0.3 is the current public Apple silicon release and is bundled as `Rill.app` and a DMG.

## Reproducible local build

```bash
npm ci
npm run desktop:build
```

Expected artifacts:

- `src-tauri/target/release/bundle/macos/Rill.app`
- `src-tauri/target/release/bundle/dmg/Rill_1.0.3_aarch64.dmg`

The default development configuration uses ad hoc signing
(`signingIdentity: "-"`). Public artifacts must instead be built with the
release configuration and the notarized release script described below.

## Validation

```bash
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/release/bundle/macos/Rill.app
codesign -dvvv --entitlements :- \
  src-tauri/target/release/bundle/macos/Rill.app
spctl -a -vv --type execute \
  src-tauri/target/release/bundle/macos/Rill.app
shasum -a 256 src-tauri/target/release/bundle/dmg/*.dmg
```

An ad hoc build is expected to fail the Gatekeeper assessment because it has no
Developer ID ticket. Bundle integrity verification must still pass.

## Notarized public release

Before public distribution without Gatekeeper warnings:

1. Install a valid `Developer ID Application` certificate.
2. Replace ad hoc signing with that identity and enable the required hardened
   runtime settings through the Tauri release configuration.
3. Build the app and DMG, then submit the DMG with `xcrun notarytool`.
4. Staple the accepted ticket with `xcrun stapler staple`.
5. Generate `Rill_1.0.3_SHA256SUMS.txt` beside the notarized DMG and repeat
   `codesign`, `spctl`, and checksum validation on the final artifact.

The checksum file is a release artifact created by `npm run release:macos`.
The ordinary `npm run desktop:build` development build does not create it.

Do not commit Apple credentials, signing certificates, keychain exports, or
notarization profiles to this repository.

# Release Rill for macOS

Rill keeps local test builds separate from signed and notarized public builds.

## One-time setup

1. Create a `Developer ID Application` certificate in the Apple Developer
   account and install it, with its private key, in the login Keychain.
2. Confirm the exact identity and Team ID:

   ```sh
   security find-identity -p codesigning -v
   ```

3. Store notarization credentials in the Keychain:

   ```sh
   xcrun notarytool store-credentials RillNotary \
     --apple-id "APPLE ID" \
     --team-id "TEAM ID" \
     --password "APP-SPECIFIC PASSWORD"
   ```

Never store a password, private key, certificate export, or notarization token
in the repository.

## Public build

Start from a clean, committed worktree with every recursive submodule checked
out at the commit recorded by the release source.

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR NAME (TEAMID)"
export RILL_NOTARY_PROFILE="RillNotary"
npm run release:macos
```

The release command signs the app, builds the DMG, submits it to Apple, staples
the accepted ticket, verifies Gatekeeper acceptance, and creates
`Rill_1.0.4_SHA256SUMS.txt` for the current source version. It stops before producing a public artifact if the
worktree is dirty, a submodule is missing or mismatched, or the identity or
notarization profile is unavailable.

Run the final checks again before upload:

```sh
npm run release:macos:check
```

The notarization step temporarily copies the DMG to an ASCII-only path because
`stapler` can mishandle normalized Unicode in a project path. Only the verified,
stapled DMG is copied back to the bundle directory.

## Local development build

```sh
npm run desktop:build
```

The default configuration uses ad hoc signing. It is suitable for local testing
only and must not be uploaded as a public release.

## Version rule

The release version must match in `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
`src-tauri/tauri.conf.json`. Create the public tag only after the signed DMG,
notarization, native-app smoke test, and release checks all pass. Never move or
reuse a published tag.

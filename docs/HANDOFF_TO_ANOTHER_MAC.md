# Continue Rill development on another Mac

This guide restores the current Rill source and development environment without
copying local build products or personal library data.

## Source of truth

- Public repository: `https://github.com/Ikepersan/rill.git`
- Current signed public release: `1.0.3`
- Current source target: `1.0.4` (not yet a signed public download)
- Published release tags are immutable. Continue work from the current branch or
  create a new `codex/` branch from the latest public `main` revision.
- Clone submodules recursively. The PDF engine is pinned to audited revisions.

Do not copy a worktree path or commit hash from an old Mac into this guide. Use
Git branches and tags to identify source; local worktree paths are disposable.

## Required tools

- Apple silicon Mac and a current macOS release
- Xcode and Command Line Tools
- Git
- Node.js `22.13.0` or newer (`.node-version` records the tested baseline)
- Rust and Cargo from the checked-in `rust-toolchain.toml`
- An Apple Developer Program account for public distribution

## Restore the project

```sh
git clone --recurse-submodules https://github.com/Ikepersan/rill.git
cd rill
npm ci
npm run test:desktop
npm run desktop:frontend:build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

If the repository was cloned without submodules:

```sh
git submodule update --init --recursive
```

Start the native development app with:

```sh
npm run desktop:dev
```

Create a local, ad hoc signed build with:

```sh
npm run desktop:build
```

The generated app and DMG are under `src-tauri/target/release/bundle/`. These
files are local build products and are not stored in Git.

## Personal library data

Git contains source code only. It does not transfer PDFs, `.rill` metadata,
Reading Notes, an Obsidian Vault, exported references, or the selected library
location. Allow the chosen local or synchronized folder to finish downloading,
then select that library root again in Rill.

The `1.0.4` source does not require Obsidian or register/check a Vault on the current Mac.
Markdown notes and PDF highlights continue to be stored under `Notes`, with
external-edit conflict protection. Existing `.obsidian` folders are left
untouched, so the library can still be opened manually in an external editor.
Rill no longer includes Obsidian setup or launch actions. No Mac-specific library
path is embedded in the DMG.

Never commit copyrighted papers, patient information, personal notes, API
credentials, Apple signing keys, certificates, or notarization credentials.

## Signing and notarization

Developer ID certificates include a private key and are not reproduced by
cloning the repository. Import the certificate securely into the login Keychain
or create an authorized certificate for the Mac, then store a `notarytool`
profile locally. Follow [`releasing-macos.md`](releasing-macos.md) for the signed
and notarized release workflow.

Validate that the local Mac can sign before attempting a public build:

```sh
security find-identity -p codesigning -v
xcrun notarytool history --keychain-profile RillNotary --output-format json
```

Secrets and keychain profiles must remain outside the repository.

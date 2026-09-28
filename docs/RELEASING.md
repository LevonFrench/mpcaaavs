# Releasing mpc-hc-aaavs

Use the current source revision and a clean build. Build and test according to [BUILDING.md](BUILDING.md), then stage the renderer. Close the candidate application before packaging.

## Create the public-only preview

```powershell
python tools/package-release.py --label preview
```

The label accepts letters, digits, dots, hyphens, and underscores. `--player-directory` and `--output-directory` accept alternative absolute locations. Existing outputs are never overwritten. The default output is `releases/mpc-hc-aaavs-preview-windows-x64-lite/`, with a matching ZIP, ZIP SHA-256 sidecar, and an `-extracted` verification directory.

The packager copies only the renamed executable, the three built worker/host bundles, the host HTML, public documentation, and required source notices. It creates a fresh collection from the 16 tracked NERV manifests; it never copies the installed catalog. A clean INI selects portable settings. Local DirectX, MediaInfo, and icon-library DLLs are not taken from another application's installation. Runtime prerequisites therefore remain required on the destination machine.

It rejects linked inputs and embedded paths to the build checkout or user profile. A `SHA256SUMS` file covers the package's files; every extracted file is checked against the manifest before success. Neither the package nor its manifest contains absolute build paths or Git author/email information. No `.pdb`, `.lib`, `.exp`, private AVS/bitmap packs, setups, ratings, history, or WebView profile is distributed.

## Validate the exact candidate

1. Confirm the native and JavaScript checks passed on the candidate revision. Run the installed-startup CPU check against the extracted package, not only the development install.
2. On a test machine with the documented prerequisites, open an audio file and confirm AAAVS occupies the artwork area. Test resize, DPI, full screen, pause, seek, repeat, stop, and video playback.
3. Verify preset previous/next, shuffle, each star threshold, empty eligible pools, F6/F7 ratings, F8 failure marks, clearing marks, and saved setup reload. Verify file changes inside the extracted test copy.
4. Audition tempo acquisition and automatic phrase changes on several tracks. Test fixed NERV timing, any-to-any scene transitions, replay, and both manual/automatic transition toggles.
5. Inspect the ZIP inventory and release notes. Record the exact ZIP hash and clearly distinguish CPU/build checks from live visual checks.

## Publish

Publish only an approved candidate with its ZIP SHA-256 sidecar, release notes, and corresponding source revision/archive. Retain GPL and third-party notices and satisfy the source-distribution requirements for the binary being shared. The packager creates local artifacts; it does not create a tag, upload files, rename a GitHub repository, or claim a release has been published.

## Privacy scope

The public working tree and newly created artifacts should contain no machine-specific checkout path, user profile path, private track history, or private collection metadata. Required upstream author and copyright attribution must remain. Existing Git commit authors, emails, prior revisions, and the repository host account are separate from the current file content; cleaning the current tree does not rewrite published history.

# mpc-hc-aaavs

An independent [MPC-HC](https://github.com/clsid2/mpc-hc) fork with the AAAVS music visualizer embedded in the album-art area. MPC-HC handles decoding and playback; the visualizer receives decoded audio and follows the player's song clock. Video playback keeps the usual video renderer.

**Preview software for Windows x64.** The current build is Release Lite: it requires compatible installed DirectShow codecs, the Microsoft Edge WebView2 Runtime, and the DirectX End-User Runtime. It is not a self-contained codec bundle or an official MPC-HC release. Native builds and CPU regression checks are separate from live playback and GPU validation.

Automatic update checks are disabled for this preview. Install future fork builds manually from the repository where you obtained this one; the player does not offer upstream MPC-HC builds as fork updates.

## Start

Extract the complete portable preview ZIP into a writable folder, install the prerequisites above, and open **mpc-hc-aaavs.exe**. Keep the `visualizer` folder beside the executable. Enable MPC-HC's AudioSwitcher for visualizer audio; bitstream passthrough does not expose decoded PCM. The public package includes **16 NERV scenes** and does not contain a private historical AVS collection.

The toolbar adds previous preset, next preset, shuffle, and Auto beside the playback controls. Open **View > Visualizer** for the manager, setup builder, and visualizer options. Playback transport keeps its ordinary function.

| Default shortcut | Action |
| --- | --- |
| Ctrl+F6 | Open Preset Manager |
| Ctrl+F7 | Open Setup Builder |
| F6 / F7 | Lower / raise the displayed preset's rating |
| F8 | Mark the displayed preset as not working |
| Escape | Close the management panel |

All visualizer commands are listed with MPC-HC commands in **Options > Player > Keys**. Preset Manager can clear a not-working mark. **Shuffle minimum rating** offers All, 1+, 2+, 3+, 4+, and 5 stars; All includes unrated presets. Not-working presets are excluded from automatic selection. Ratings and failure marks belong to the installed collection, and errors are reported in the interface.

## Presets, setups, and timing

- Browse, search, sort, rate, and load presets in Preset Manager. A rating adds `[N stars]` to the preset filename and updates Date modified while preserving its content identity.
- Build ordered preset setups with saved shuffle and transition preferences. The [management guide](docs/PRESET-MANAGEMENT.md) explains persistence and recovery.
- Auto uses inferred four-beat bars with adaptive 2-12-bar or fixed phrase lengths. It waits for a trusted tempo and holds during silence, pauses, and discontinuities. Inferred tempo and bar alignment are not song-structure recognition.
- Choose from 14 classic AVS transition styles, Random, and Cut; fixed or beat-based durations; and separate manual/automatic transitions. See [transition behavior](docs/AVS-TRANSITIONS.md).
- **Setup Builder > NERV scene set** supplies 16 scenes with repeatable song-time sequencing. Set BPM, offset, bars per scene, and a shuffle seed. Scene choices can queue for the next timing boundary, including transitions between any two scenes. See [NERV scenes](docs/NERV-SCENES.md).

Historical AVS packs, bitmap packs, fonts, and APE binaries are **not distributed**. Bring an existing compatible catalog under `visualizer/avs presets/` beside the executable, including `catalog/presets.json`, `catalog/parser-validation.json`, optional `catalog/dependencies.json`, and its referenced preset/dependency files. The host verifies preset bytes and SHA-256 before rendering. Historical APE binaries are never executed. Catalog inclusion does not guarantee faithful support for every legacy effect.

## Build and release

Stock AAAVS can also use the shared Player, preset management, transitions and
NERV timing while retaining its Studio and offline tools. See the
[shared development and mirroring guide](docs/AAAVS-SHARED-DEVELOPMENT.md).

Start with the [build guide](docs/BUILDING.md). Maintainers can create a public-only archive using the [release guide](docs/RELEASING.md); the packager creates a SHA-256 inventory and verifies an extracted copy. It does not copy private presets, saved setups, playback history, WebView profiles, debug symbols, or personal configuration.

[Preview release notes](docs/RELEASE-NOTES.md) record the current scope and remaining live validation. [Audio implementation notes](docs/AUDIO-WIRING.md) explain the CPU audio/tempo regressions. Multichannel analysis uses the first two channels. Live latency, visual fidelity, DPI/fullscreen behavior, and device recovery still require testing on the release candidate.

## License and attribution

The fork preserves MPC-HC history and builds on upstream commit `8e1cc8761f8dfb0352779ace61c85774e4705fd5`. Code is distributed under the repository's [GPL v3 terms](COPYING.txt), with existing third-party notices retained. The [original MPC-HC README](docs/MPC-HC-UPSTREAM-README.md), [AVS transition notice](THIRD-PARTY-AVS-TRANSITIONS.txt), and [NERV attribution](THIRD-PARTY-NERV.txt) remain available. Preset and dependency packs have their own terms.

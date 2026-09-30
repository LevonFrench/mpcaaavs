# HUD packs

HUD presets use the shared Player and MPC host. They are procedural Canvas2D scenes, with authored clocks for counters, timers and progress, and audio signals for decoration. Original artwork and source screenshots are not embedded in a scene.

The local bank has two parts: 15 authored showcase scenes and a source-complete generated bank. The generator reads every kit and every source-index entry without deduplication or a per-platform cap. Generated scenes carry the `auto` tier and remain visually unreviewed; passing schema, geometry, palette, budget and replay checks does not establish visual fidelity.

## Playback

Open Preset Manager and select a folder under **HUD packs**. **Play folder** uses the folder's ordered membership without the saved setup's 500-preset limit. The built-in pack defaults provide scene length, shuffle and transition settings; a saved folder bundle overrides them. Stop folder play returns to the library. Ctrl+F8 replays the last folder.

The 16 pack labels are Showcase; Arcade · Fighting; Arcade · Action; Neo Geo; Vector & Early Arcade; 8/16-bit Consoles; 32/64-bit Consoles; 128-bit Consoles; Handheld & LCD; Home Computers; PC Classic; Flight, Space & Racing; Modern; Rhythm; Cinema & TV; Anime & Mecha. Large packs receive alphabetic buckets. Console label slashes are preserved as part of the label.

HUD templates are editable saved setups, capped at 500 entries. Folder play remains the route for a larger bank. Default AVS playback keeps its classic resolution policy. HUD pixel canvases use their authored grid and pixel aspect; vector canvases use the selected render tier. Display controls expose quality, AVS resolution, pixel sampling and FPS detail.

## Local generation and installation

Run these commands from the visualizer directory. `--index` can override the source-index location; `--index none` makes an explicitly kit-only run.

```powershell
npm run build:hud-packs
npm run check:hud-local
node tools/build-hud-packs.mjs --all --dry-run --out-dir <scratch-output> --private-dir <private-output>
node tools/install-hud-presets.mjs <collection-directory> --source <hud-presets-directory> --local-overlay <private-title-overlay>
```

Use a separate test collection for an audition. The installer preflights paths and identifiers, refuses links and changed scene identifiers by default, preserves existing catalog rows and ratings, and uses atomic individual-file replacement. `--supersede` explicitly permits replacing a changed scene identifier while retaining its rating and not-working state. Public titles are neutral; the optional real-title overlay is local catalog data.

Superseded HUD versions remain in the on-disk catalog as history and are excluded from the current playback catalog. Saved references to obsolete hashes remain stored; they need a current replacement to become playable again.

Generated `hud-presets` are ignored by Git, excluded from the stock mirror, and excluded from public release packages. Private overlays, source titles, source kits, media, ratings, history and personal configuration must remain outside public artifacts. Public runtime builds contain the HUD worker so users can install their own local bank. The included public preset bank remains the 16 NERV scenes.

## Timing and validation

Clock-driven values reconstruct from absolute media time, the saved grid, scene bounds and named intervals. Previous HUD manifests are hash-verified and cached before a seek or fade renders both plates. Unknown track duration stays unknown. Seeking or discontinuity resets the live audio analyser; live audio decoration may differ while it warms up, while clock-driven values remain repeatable. Transport revisions and analysis `dt` are metadata, not song-clock authority.

HUD-to-HUD and NERV-to-HUD clock fades reconstruct both plates in the HUD worker. HUD-to-NERV clock boundaries cut because the NERV worker does not reconstruct HUD manifests. Manual mixed transitions use the host compositor.

The CPU gates cover all 21 instrument types, three render sizes, replay/seek behavior, geometry budgets, signal bounds, installer preservation and shared host routing. Both runtime builds include the HUD worker. End/hit transition anchors, quantized manual queues and transport lead behavior remain follow-up work; controls requiring these capabilities stay disabled. Real Canvas2D frame cost, visual legibility and audible response need separate runtime evidence.

Decorative reconstructable bindings use media-time inertia; authoritative timers and counters keep exact endpoints. Arbitrary live RMS/band/pan/contour bindings use bus smoothing; per-binding live-history overrides remain a follow-up. Source completeness does not establish fidelity: unavailable or unsupported reference images produce authored fallback skins. All auto scenes remain visually unreviewed.

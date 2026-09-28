# Preset ratings and setups

The View menu includes **Preset Manager** (Ctrl+F6) and **Setup Builder** (Ctrl+F7). These defaults do not replace existing MPC-HC bindings. All four new commands are registered in Options → Player → Keys, alongside the player's existing commands. The management view also includes a shortcut reference. Escape closes the view; typing in its fields does not trigger playback shortcuts.

**F7** raises the currently displayed preset's rating; **F6** lowers it. Ratings are clamped to 1–5 stars; an unrated preset starts at one star. The manager's star buttons rate the selected row, which may differ from the playing preset. Repeated shortcut requests are queued and acknowledged after saving.

A rated preset receives a suffix such as `Original name [3 stars].avs`. The content hash prefix, AVS bytes, and bitmap identity remain unchanged. The application explicitly updates the file's last-write timestamp so Explorer's **Date modified** changes, and atomically updates the catalog's path and rating. Failed catalog saves roll back the rename and timestamp. Existing target files are never overwritten. Linked paths outside the installed collection are rejected. Errors are shown in the interface.

The manager provides search, minimum-rating filtering, name/rating sorting, paging, and direct loading. It uses the installed preset collection beside the executable. Ratings are not written to the original AAAVS demo or a separate source checkout.

## Setups

A setup is a saved ordered preset list plus shuffle, Auto phrase length, transition style/duration, and manual/automatic transition preferences. It is not an editor for the effects inside an AVS preset.

1. Open Setup Builder and choose **New setup**.
2. Select presets on the left and use **Add to setup**.
3. Reorder with the arrow buttons, remove unwanted entries, and set playback/transition options.
4. **Save setup** persists it; **Activate setup** applies it to this session. Unsaved drafts can be activated without overwriting a saved setup.
5. **Use entire library** clears the active preset-list restriction. Saved setups remain available on the next launch; select and activate one to use it again.

Setups use content hashes rather than filenames, so ratings and renames do not break them. A missing or unavailable preset blocks activation with an explanation. Deleting a saved setup does not delete preset files. Automatic preset changes wait while a management view is open.

Saved setup data lives in `visualizer/avs presets/setups.json` relative to the executable. The staging script preserves an existing installed catalog and preset bank, including filename ratings; rebuilding updates application code and dependencies without restoring the old names. Deliberately replacing a preset collection is a separate operation.

## Validation

- Native filesystem fixture: repeated ratings, actual renames, timestamp changes, unchanged AVS bytes, atomic-write rollback, rejected traversal and unknown identities.
- CPU DOM/model fixtures: rating and load controls, setup composition/save acknowledgement/reload/activation, malformed settings, missing presets, persistence errors, and panel closing.
- Host fixture: keyboard routing, rating requests against the committed preset, queued increments, and catalog path updates.
- Existing audio, clock, navigation, safety and lifecycle regressions remain required.

No player, browser, or GPU was launched during implementation. Native compilation and CPU checks do not establish visual, focus, DPI, or live shortcut acceptance in WebView2.

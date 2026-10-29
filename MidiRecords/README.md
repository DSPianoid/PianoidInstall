# MidiRecords

The standard folder for your MIDI files. The MIDI Player pane's **Open** dialog starts here, and
its **Library** menu lists every `.mid` / `.midi` / `.kar` file in it (subfolders included).

Everything you put here stays local: the folder's contents are git-ignored (only this README is
tracked). To use another folder, set `midi_dir` in `pianoid_local_settings.json` or the
`PIANOID_MIDI_DIR` environment variable. The bundled example songs live in
`PianoidCore/pianoid_middleware/MIDI_records/`.

# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - 2026-08-23

### Added
- Initial release of **PRTF-edit** (Preview).
- **Definition tree** for DDS printer file source: File, Records, Fields, and Constants, kept in sync automatically as you type, with click-to-navigate to the source line.
  - The File node shows the source member's own name and its file-level attributes.
- **Page-layout preview**: a print-style simulation of a record's layout on a configurable character grid (rows × columns), with `O`/`6` field placeholders and edit-code-aware widths for numeric fields.
  - `COLOR`, `HIGHLIGHT`, and `UNDERLINE` render visually, at both record and field level.
  - Drag & drop repositioning for both explicit Line/Position records and "flow" records (`SKIPB`/`SPACEB`/`SPACEA`/`SKIPA`), adjusting whichever positioning style applies.
  - "+ Field" / "+ Constant" placement directly on the page.
  - In-place editing from a selected field/constant: Delete, Attributes, and Spacing, without leaving the preview.
  - **Overlay**: show another record dimmed behind the one being edited, with an optional "repeat" mode that tiles it down the whole page — handy for aligning a totals record against a detail record positioned much further down.
  - **Compose sequence**: preview several record formats together, each with its own repeat count, the way they'd actually print in sequence (header, detail rows, totals), with automatic page breaks and optional repeating "standing" headers.
  - **Indicators** simulation: toggle which indicators are on/off to preview conditional fields, constants, and keywords — including a conditioned `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` shifting everything printed after it, and indicators used only on a record-level keyword.
  - **Ruler** (row/column numbers) and **Focus mode** (hide the source editor) toggles.
- **Context menu actions** from the Definition tree:
  - Records: New, Rename, Copy, Delete; edit Attributes (`HIGHLIGHT`, `ENDPAGE`, `FONT`); edit Spacing (`SKIPB`/`SPACEB`/`SPACEA`/`SKIPA`).
  - Fields: Rename, Copy, Delete; edit Attributes (`TEXT`, `COLOR`, `HIGHLIGHT`, `UNDERLINE`, `EDTCDE` for numeric fields, `FONT`, `CHRID`); edit Indicators.
  - Constants: Edit Text, Fill to Width of..., Copy, Delete; edit Attributes; edit Indicators.
  - File: edit Spacing (`SKIPB`/`SKIPA`) — applied before/after every record format in the file, matching real DDS semantics.
  - `FONT` and `CHRID` are checked against each other before applying: a graphic font name and `CHRID` can't be combined on the same field per DDS, so setting one while the other is already in effect (directly, or inherited from the record's own `FONT`) is blocked with an explanation.
- **Indicators**: condition a field, constant, or keyword — including a record's own attribute — on up to 9 ANDed indicators, or add an OR'd alternative, with DDS's own continuation-line rules handled automatically.
- **Diagnostics**: the Problems panel flags a record format that mixes an explicit Line entry with `SPACEA`/`SPACEB`/`SKIPA`/`SKIPB` — a real `CRTPRTF` rejection — before you ever try to compile it.

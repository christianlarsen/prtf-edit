# PRTF-edit

**PRTF-edit** is a Visual Studio Code extension for creating and editing DDS source for IBM i **printer files** (PRTF). It gives you a navigable outline of your record formats, fields, and constants, a visual print-layout preview, and a set of guided editing tools — so you can build and adjust a printer file's layout without hand-counting DDS's fixed source columns.

---

## ✨ Features

### Definition tree
- A dedicated **PRTF Structure** view in the Activity Bar lists every record format, field, and constant in the open source, grouped and kept in sync automatically as you type.
- Click any item to jump straight to its line in the source.
- Records, fields, and constants each show a short summary right in the tree (position, indicators, ...).
- Right-click menus let you create, rename, copy, and delete records, fields, and constants without hand-editing the source (see **Editing from the tree** below).

### Page-layout preview
- Click the preview icon on a record to open a print-style simulation of its layout, rendered on a character grid at the page size you choose (rows × columns, default 66×132).
- Fields show as `O` or `6` placeholders (the familiar SDA/DFU convention) — hover one for its name and description. A numeric field with an edit code (`EDTCDE`) is shown at its worst-case edited width (commas, sign), not just its raw length.
- `COLOR`, `HIGHLIGHT`, and `UNDERLINE` render visually, at both record and field level.
- Drag a field or constant anywhere on the page to reposition it — the preview understands both records positioned with an explicit Line/Position and "flow" records positioned via `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA`, adjusting whichever applies.
- **"+ Field" / "+ Constant"**: click the button, then click a spot on the page to place a new one there. A long constant automatically splits across DDS's own continuation convention.
- Select a field or constant on the page to edit it right there: **"🗑 Delete"** removes it entirely, **"🎨 Attributes"** sets or clears `TEXT`/`COLOR`/`HIGHLIGHT`/`UNDERLINE`/`EDTCDE` from a simple picker, **"↕️ Spacing"** sets or clears its own `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` — no need to open the tree or remember DDS keyword syntax. Clicking empty space clears the selection.
- Right-clicking a field or constant also opens the spacing editor directly, with the option to convert an explicit-Line record to flow positioning in one step.
- **"Overlay"**: show another record dimmed behind the one you're editing, to check alignment between them — e.g. a header against the detail line printed below it.
- **"Compose sequence"**: preview several record formats together — each with its own repeat count — the way they'd actually print one after another (a header, several detail rows, a total line), with automatic page breaks once the content passes your configured page length.
- **"Indicators"**: simulate which indicators are on or off, to see exactly which fields, constants, and keywords would print — including how a conditioned `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` shifts everything printed after it. Only shown when the record you're viewing actually uses indicators.
- **"📏 Ruler"** for row/column numbers alongside the page, **"🗖 Focus"** to hide the source editor and concentrate on the preview.

### Editing from the tree
Right-click any record, field, or constant in the Definition tree:
- **Records** — New, Rename, Copy, Delete, edit Attributes (`HIGHLIGHT`/`ENDPAGE`), edit Spacing (`SKIPB`/`SPACEB`/`SPACEA`/`SKIPA`).
- **Fields** — Rename, Copy, Delete, edit Attributes, edit Indicators.
- **Constants** — Edit Text (its own literal text), Fill to Width of... (pad it with spaces to match another field's or constant's printed width, anywhere in the file — handy for lining up a header label with the field printed below it), Copy, Delete, edit Attributes, edit Indicators.
- **Attributes**: for a field/constant, `TEXT`, `COLOR`, `HIGHLIGHT`, `UNDERLINE`, and — for numeric fields and `PAGNBR` — `EDTCDE`, the same simple picker as the preview's own "🎨 Attributes" button; for a record, `HIGHLIGHT` and `ENDPAGE`, the two record-level keywords the preview understands.
- **Spacing** (records only): the same `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` editor a field/constant already gets from the preview, for the record format itself.
- **Indicators**: condition a field, constant, or keyword — including a record's own attribute — on up to 9 ANDed indicators, or add an OR'd alternative — DDS's own continuation-line rules for indicators are handled for you automatically.
- Copying a field or constant that carries its own `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` asks whether to bring that spacing along, since it describes where the item sits *relative to whatever's before it*, not a property of the item itself.

### Diagnostics
- The Problems panel flags a record format that mixes an explicit Line entry with `SPACEA`/`SPACEB`/`SKIPA`/`SKIPB` — DDS doesn't allow combining the two positioning styles in the same record, and this is caught before you ever try to compile it.

---

## 🚀 How to Use

1. Open a DDS printer file source (language id `dds.prtf`) in VS Code.
2. Click the **PRTF Structure** icon in the Activity Bar.
3. The **Definition** view appears automatically, showing your records, fields, and constants.
4. Click any item to jump to it in the source, or use the preview icon on a record to open its **Page-Layout Preview**.

---

## ⚙️ Requirements

- Visual Studio Code **v1.75** or higher.
- Recommended: the [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi) extension, for source member access and the `dds.prtf` language id.

---

## 🐞 Known Issues

This extension is currently in **preview**.
Some features may not work as expected. Please leave an issue if something isn't working right!

---

## 📝 To Do

- Bug fixes as they turn up.
- Wider keyword coverage: the large AFPDS-only graphics surface (`AFPRSC`, `BOX`, `LINE`, `GDF`, `OVERLAY`, `PAGSEG`, `POSITION`, barcodes, fonts, DBCS) is out of scope for now.
- `PRTQLTY`/`LPI`/`CPI`/`DUPLEX`/`DRAWER`/`OUTBIN` support.
- Many new features to come!

---

## 📦 Version History
See the full changelog [here](./CHANGELOG.md).

### Latest
**0.0.1** - 2026-08-17
- First release.

---

💬 **Feedback is welcome!** Please leave a comment, open an issue, and enjoy using PRTF-edit.

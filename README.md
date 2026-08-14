# Printer File DDS edit

VS Code extension to create and modify DDS **printer files** (PRTF) on IBM i — sibling project to
[dspf-edit](https://github.com/christianlarsen/dspf-edit) (display files), reusing its architecture
and, where it makes sense, its patterns and code.

Status: early skeleton. Activates on `dds.prtf` documents (as assigned by the Code for IBM i
extension) and registers an empty "Definition" tree view — no parsing yet.

## Why a separate project instead of extending dspf-edit

DSPF is an interactive, absolute-position screen (row/col given directly, input fields, function
keys, windows, subfiles). PRTF is a page-based, non-interactive stream: vertical position is
usually *relative* (SPACEA/SPACEB/SKIPA/SKIPB advance a line cursor), there's page size/overflow
instead of a fixed screen, and no windows/subfiles/colors. The preview — the core of dspf-edit — has
to simulate a layout engine instead of just painting a fixed grid, so it's a different problem
underneath a similar shell. Starting as its own repo avoids forcing that divergence into dspf-edit's
codebase; genuinely-reusable pieces (IBM i connection glue, DDS fixed-column tokenizer basics) get
copied over and adapted rather than shared via a package, unless/until duplication actually becomes
painful.

## Roadmap

- [x] Fase 0 — Scaffold: repo, activation on `dds.prtf`, empty tree view.
- [ ] Fase 0b — Spec: confirm exact PRTF fixed-column layout and target keyword set (PAGSIZ,
      SPACEA/SPACEB, SKIPA/SKIPB, OVERFLOW, OVERLAY, LPI, CPI, PAGNBR, DATE/TIME/USER, EDTCDE/EDTWRD,
      indicators) against the DDS reference.
- [ ] Fase 1 — Parser + model: fixed-column tokenizer, record/field/constant tree, line/position
      resolution.
- [ ] Fase 2 — Definition tree view wired to the real parser.
- [ ] Fase 3 — Preview, read-only: one page, one record, line cursor with SPACE/SKIP simulation.
- [ ] Fase 4 — Preview, interactive: bidirectional selection between preview and source.
- [ ] Fase 5 — Preview, editing: move/add fields and constants from the preview.
- [ ] Fase 6 — Multi-record / multi-page composition.

## Development

```bash
npm install
npm run watch   # or F5 in VS Code to launch the Extension Development Host
```

Requires the [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi)
extension for source member access and the `dds.prtf` language id.

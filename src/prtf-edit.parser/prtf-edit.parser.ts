/*
  Christian Larsen, 2026
  "PRTF structure"
  prtf-edit.parser.ts
*/

import {
    PrtfElement,
    PrtfRecord,
    PrtfField,
    PrtfConstant,
    PrtfIndicator,
    PrtfFile,
    PrtfAttribute,
    isLiteralConstantValue,
    systemKeywordPlaceholder
} from '../prtf-edit.model/prtf-edit.model';

/**
 * Tracks the last resolved (row, col, length) of a positioned field/constant within the current
 * record, in source order. A blank Line (row) means "continue on the same row as the preceding
 * field/constant", and a Position (col) written as "+n" means "n blank positions after the end of
 * that preceding field/constant" — both relative to whatever came immediately before in this
 * record, not to any fixed origin. Identical rule to DSPF's (see "Location for printer files
 * (positions 39 through 44)" in the DDS reference). `row` can itself be undefined here (a
 * flow-mode record, no Line anywhere) — it's still tracked so `col`/`length` stay available for
 * "+n" column chaining even though row resolution for flow-mode records happens later, in
 * resolveFlowModePositions.
 */
let lastPositionInRecord: { row: number | undefined; col: number; length: number } | undefined;

/**
 * AND-groups accumulated so far from indicator-only continuation lines (position 7 = 'A'/blank,
 * or 'O' to start a new OR'd group), waiting to be attached to the next field/constant/keyword
 * line that actually names something.
 */
let pendingIndicatorGroups: PrtfIndicator[][] = [];

function resetPendingIndicatorGroups(): void {
    pendingIndicatorGroups = [];
};

/**
 * True when a line is a pure indicator continuation line: it carries its own conditioning
 * indicators (columns 8-16) but no keyword text (columns 45-80).
 * @param trimmedLine - Line with the sequence number area removed
 * @param indicators - This line's own indicators, already parsed from columns 8-16
 */
function isIndicatorOnlyLine(trimmedLine: string, indicators: PrtfIndicator[]): boolean {
    if (indicators.length === 0) {return false;}
    return trimmedLine.substring(39, 75).trim() === '';
};

/**
 * Folds a line's own indicators into the pending buffer according to its column-7 marker: 'O'
 * starts a new OR'd group, 'A' (or blank, the default) extends the AND group currently being built.
 * @param marker - The line's column-7 character
 * @param indicators - The line's own indicators (columns 8-16)
 */
function accumulatePendingIndicators(marker: string, indicators: PrtfIndicator[]): void {
    if (marker === 'O' && pendingIndicatorGroups.length > 0) {
        pendingIndicatorGroups.push([...indicators]);
    } else {
        if (pendingIndicatorGroups.length === 0) {pendingIndicatorGroups.push([]);}
        pendingIndicatorGroups[pendingIndicatorGroups.length - 1].push(...indicators);
    };
};

/**
 * Resolves the final, group-tagged indicator set for a terminating element line: folds its own
 * indicators into any pending continuation groups per its own column-7 marker, then flattens the
 * result — each indicator tagged with its (zero-based) OR-group index — and clears the pending
 * buffer.
 * @param marker - The terminating line's column-7 character
 * @param ownIndicators - The terminating line's own indicators (columns 8-16)
 */
function resolveLineIndicators(marker: string, ownIndicators: PrtfIndicator[]): PrtfIndicator[] {
    if (pendingIndicatorGroups.length === 0) {
        return ownIndicators.map(ind => ({ ...ind, group: 0 }));
    };

    accumulatePendingIndicators(marker, ownIndicators);
    const groups = pendingIndicatorGroups;
    resetPendingIndicatorGroups();

    return groups.flatMap((group, groupIndex) => group.map(ind => ({ ...ind, group: groupIndex })));
};

/**
 * Main parser function that processes PRTF document text and returns structured elements.
 * @param text - Raw DDS document text to parse
 * @returns Array of parsed PRTF elements (file/record/field/constant — 'attribute' elements are
 * merged into their parent and filtered out of the returned array)
 */
export function parseDocument(text: string): PrtfElement[] {
    const lines = text.split(/\r?\n/);
    const prtfElements: PrtfElement[] = [];

    clearGlobalState();

    const rootFile = createRootFileElement();
    prtfElements.push(rootFile);

    const parsedElements = parseAllLines(lines);
    prtfElements.push(...parsedElements);

    linkAttributesToParents(prtfElements);
    resolveFlowModePositions(prtfElements);
    assignRecordEndIndices(prtfElements, lines.length);

    return prtfElements.filter(el => el.kind !== 'attribute');
};

function clearGlobalState(): void {
    lastPositionInRecord = undefined;
    resetPendingIndicatorGroups();
};

function createRootFileElement(): PrtfFile {
    return {
        kind: 'file',
        lineIndex: 0,
        attributes: []
    };
};

function parseAllLines(lines: string[]): PrtfElement[] {
    const elements: PrtfElement[] = [];
    let currentRecord = '';
    let lineIndex = 0;

    while (lineIndex < lines.length) {
        const parseResult = parseSingleDdsLine(lines, lineIndex, currentRecord);

        if (parseResult.element) {
            elements.push(parseResult.element);
        };

        currentRecord = parseResult.lastRecord;
        lineIndex = parseResult.nextIndex + 1;
    };

    return elements;
};

function parseSingleDdsLine(
    lines: string[],
    lineIndex: number,
    lastRecord: string
): { element: PrtfElement | undefined; nextIndex: number; lastRecord: string } {

    const line = lines[lineIndex];
    const trimmedLine = line.substring(5); // Skip sequence number area (positions 1-5)

    // Skip comment lines (column 7 = '*')
    if (trimmedLine.charAt(1) === '*') {
        return { element: undefined, nextIndex: lineIndex, lastRecord };
    };

    const lineComponents = extractLineComponents(trimmedLine);
    // Column 7: blank/'A' continues (or starts) an AND group, 'O' starts a new OR'd group.
    const conditionMarker = trimmedLine.charAt(1);

    if (isRecordLine(trimmedLine)) {
        // This conditioning mechanism applies to fields/constants/keywords, not record lines.
        resetPendingIndicatorGroups();
        return parseRecordElement(lines, lineIndex, trimmedLine, lastRecord);
    };

    if (isFieldLine(lineComponents.fieldName)) {
        const indicators = resolveLineIndicators(conditionMarker, lineComponents.indicators);
        return parseFieldElement(lines, lineIndex, trimmedLine, { ...lineComponents, indicators }, lastRecord);
    };

    if (isConstantLine(lineComponents)) {
        const indicators = resolveLineIndicators(conditionMarker, lineComponents.indicators);
        return parseConstantElement(lines, lineIndex, trimmedLine, { ...lineComponents, indicators }, lastRecord);
    };

    // Neither record, field, nor constant: either a pure indicator-only continuation line, or a
    // keyword-only attribute line.
    if (isIndicatorOnlyLine(trimmedLine, lineComponents.indicators)) {
        accumulatePendingIndicators(conditionMarker, lineComponents.indicators);
        return { element: undefined, nextIndex: lineIndex, lastRecord };
    };

    return parseAttributeElement(lines, lineIndex, trimmedLine, lineComponents, lastRecord, conditionMarker);
};

/**
 * Extracts common components from a PRTF line. Column layout (identical to DSPF for positions
 * 1-44): condition/indicators 7-16, name type 17, name 19-28, Line 39-41, Position 42-44.
 * @param trimmedLine - Line with sequence number area removed
 */
function extractLineComponents(trimmedLine: string) {
    const conditionZone = trimmedLine.substring(2, 11);
    const indicators = parseDdsIndicators(conditionZone);
    const fieldName = trimmedLine.substring(13, 23).trim();
    const rowText = trimmedLine.substring(33, 36).trim();
    const colText = trimmedLine.substring(36, 39).trim();
    const row = rowText ? Number(rowText) : undefined;
    // A Position entry of "+n" is placed n blank positions after the end of the preceding
    // field/constant, rather than at absolute column n.
    const colRelative = colText.startsWith('+');
    const col = colText ? Number(colText) : undefined;

    return { indicators, fieldName, row, col, colRelative };
};

/**
 * Resolves a field/constant's actual (row, col) from the raw values read off the source, applying
 * the DDS relative record format rules (see extractLineComponents).
 * @param row - Row read from columns 39-41; undefined means the field was left blank
 * @param col - Col read from columns 42-44; undefined means the field was left blank
 * @param colRelative - True when the Position field was written as "+n"
 */
function resolvePosition(
    row: number | undefined,
    col: number | undefined,
    colRelative: boolean
): { row: number | undefined; col: number | undefined } {
    if (row === undefined && col === undefined) {
        return { row, col };
    };

    const resolvedRow = row !== undefined ? row : lastPositionInRecord?.row;

    let resolvedCol = col;
    if (colRelative && col !== undefined) {
        const previousEndCol = lastPositionInRecord
            ? lastPositionInRecord.col + lastPositionInRecord.length
            : 0;
        resolvedCol = previousEndCol + col;
    };

    return { row: resolvedRow, col: resolvedCol };
};

function isRecordLine(trimmedLine: string): boolean {
    return trimmedLine[11] === 'R';
};

function isFieldLine(fieldName: string): boolean {
    return Boolean(fieldName);
};

/**
 * Checks if the line represents a constant definition. The Line (row) entry is legitimately blank
 * under the DDS relative record format, so only the Position (col) entry is required here.
 */
function isConstantLine(components: { fieldName: string; row?: number; col?: number }): boolean {
    return !components.fieldName && Boolean(components.col);
};

function parseRecordElement(
    lines: string[],
    lineIndex: number,
    trimmedLine: string,
    lastRecord: string
) {
    const name = trimmedLine.substring(13, 23).trim();
    const { attributes, nextIndex } = extractAttributes('R', lines, lineIndex, false);

    // A new record always starts with an explicit absolute position — relative "+n"/blank-row
    // notation is only relative to a preceding field/constant within the same record.
    lastPositionInRecord = undefined;

    const element: PrtfRecord = {
        kind: 'record',
        lineIndex,
        name,
        attributes
    };

    return { element, nextIndex, lastRecord: name };
};

/**
 * System-defined length for DDS data types whose length is never written in the source's length
 * columns (position 30-34) — the format on DATFMT/TIMFMT dictates it instead. Same defaults as the
 * *ISO format (DATFMT/TIMFMT not specified): L=10 ("yyyy-mm-dd"), T=8 ("hh.mm.ss"), Z=26 (timestamp).
 */
const FIXED_LENGTH_BY_TYPE: Record<string, number> = { L: 10, T: 8, Z: 26 };

/**
 * Extracts a referenced field's REFFLD() target: the field name (and, optionally, its qualified
 * database file) whose type/length/decimals this field borrows.
 * REFFLD([record-format-name/]referenced-field-name [*SRC | [library-name/]data-base-file-name]).
 * Falls back to the field's own name when there's no REFFLD (a bare "R" referencing a file/record
 * -level REF() under the same field name).
 * @param attributes - The field's own DDS attributes
 * @param ownName - The field's own name, used as the fallback reference target
 */
function parseReffldTarget(attributes: PrtfAttribute[] | undefined, ownName: string): { fieldName: string; file?: string; library?: string; recordFormat?: string } {
    const attr = attributes?.find(a => a.value.toUpperCase().startsWith('REFFLD('));
    if (!attr) {
        return { fieldName: ownName };
    };

    const match = attr.value.match(/^REFFLD\(\s*(\S+)(?:\s+(\S+))?\s*\)$/i);
    if (!match) {
        return { fieldName: ownName };
    };

    const [, fieldSpec, qualifiedFile] = match;
    const slashIndex = fieldSpec.indexOf('/');
    const recordFormat = slashIndex >= 0 ? fieldSpec.slice(0, slashIndex) : undefined;
    const fieldName = slashIndex >= 0 ? fieldSpec.slice(slashIndex + 1) : fieldSpec;

    if (!qualifiedFile) {
        return { fieldName, recordFormat };
    };

    const [library, file] = qualifiedFile.includes('/') ? qualifiedFile.split('/') : [undefined, qualifiedFile];
    return { fieldName, file, library, recordFormat };
};

function parseFieldElement(
    lines: string[],
    lineIndex: number,
    trimmedLine: string,
    components: any,
    lastRecord: string
) {
    const type = trimmedLine[29];
    const length = Number(trimmedLine.substring(24, 29).trim()) || FIXED_LENGTH_BY_TYPE[type] || 0;
    const decimals = trimmedLine.substring(30, 32) !== ' ' ? Number(trimmedLine.substring(30, 32).trim()) : 0;
    const usage = trimmedLine[32] !== ' ' ? trimmedLine[32] : ' ';
    const programToSystem = usage === 'P';
    const isReferenced = trimmedLine[23] === 'R';

    const { attributes, nextIndex } = extractAttributes('F', lines, lineIndex, true, components.indicators);
    const refTarget = isReferenced ? parseReffldTarget(attributes, components.fieldName) : undefined;

    // Resolve DDS relative record format ("+n" position, blank line) against the preceding
    // field/constant in this record.
    const { row: resolvedRow, col: resolvedCol } = resolvePosition(components.row, components.col, components.colRelative);

    // Tracked even when resolvedRow is undefined (a flow-mode record — no Line anywhere) so "+n"
    // column chaining still works for the next field/constant; row resolution for that case
    // happens later, in resolveFlowModePositions.
    if (resolvedCol !== undefined) {
        lastPositionInRecord = { row: resolvedRow, col: resolvedCol, length };
    };

    const element = {
        kind: 'field' as const,
        name: components.fieldName,
        type: type,
        length: length,
        decimals: decimals,
        usage: usage,
        programToSystem: programToSystem,
        row: resolvedRow,
        column: resolvedCol,
        positionSource: resolvedRow !== undefined ? ('explicit' as const) : undefined,
        referenced: isReferenced,
        refTarget: refTarget,
        lineIndex: lineIndex,
        recordname: lastRecord,
        attributes: attributes || [],
        indicators: components.indicators || undefined
    };

    return { element, nextIndex, lastRecord };
};

function parseConstantElement(
    lines: string[],
    lineIndex: number,
    trimmedLine: string,
    components: any,
    lastRecord: string
) {
    const { fullValue, lastLineIndex } = extractMultiLineConstant(lines, lineIndex, trimmedLine);
    const { attributes, nextIndex } = extractAttributes('C', lines, lastLineIndex, true, components.indicators);

    // A constant's keyword-zone text is only a literal value when it's quoted ('text' or
    // X'hex') — otherwise (DATE, TIME, PAGNBR, ...) it's a bare system-keyword invocation with no
    // literal at all, coded on the same line as its Line/Position exactly like a quoted literal
    // would be. Fold it into this constant's own attributes (same as a separate keyword-only
    // continuation line would be, via linkAttributesToParents) instead of treating the raw
    // keyword text as the constant's printed name.
    const isLiteral = fullValue === '' || isLiteralConstantValue(fullValue);
    const inlineKeywordAttributes: PrtfAttribute[] = !isLiteral
        ? [{ kind: 'attribute', lineIndex, lastLineIndex, value: fullValue, indicators: components.indicators || [] }]
        : [];

    const { row: resolvedRow, col: resolvedCol } = resolvePosition(components.row, components.col, components.colRelative);

    if (resolvedCol !== undefined) {
        const printedLength = isLiteral
            ? stripConstantQuotes(fullValue).length
            : (systemKeywordPlaceholder(fullValue)?.length ?? fullValue.length);
        lastPositionInRecord = { row: resolvedRow, col: resolvedCol, length: printedLength };
    };

    const element = {
        kind: 'constant' as const,
        name: fullValue,
        // Falls back to 0 only for malformed source, or a flow-mode record whose row
        // resolveFlowModePositions couldn't determine either (e.g. no field/constant in the
        // record carries any SKIPB/SPACEB at all).
        row: resolvedRow ?? 0,
        column: resolvedCol ?? 0,
        positionSource: resolvedRow !== undefined ? ('explicit' as const) : undefined,
        lineIndex: lineIndex,
        lastLineIndex: lastLineIndex,
        recordname: lastRecord,
        attributes: [...inlineKeywordAttributes, ...(attributes || [])],
        indicators: components.indicators
    };

    return { element, nextIndex: lastLineIndex, lastRecord };
};

/**
 * Extracts multi-line constant values, following continuation characters. The value area is the
 * standard DDS keyword-area window, columns 45-80 (`substring(39, 75)` on the 5-char-stripped
 * line). A line continues onto the next when the last non-blank character in that window is a
 * hyphen.
 */
function extractMultiLineConstant(
    lines: string[],
    startIndex: number,
    trimmedLine: string
): { fullValue: string; lastLineIndex: number } {

    let fullValue = trimmedLine.substring(39, 75);
    let continuationIndex = startIndex;

    while (fullValue.trimEnd().endsWith('-')) {
        const trimmedEnd = fullValue.trimEnd();
        fullValue = trimmedEnd.substring(0, trimmedEnd.length - 1);

        continuationIndex++;
        const nextLine = lines[continuationIndex];
        if (!nextLine) {break;}

        const nextTrimmed = nextLine.substring(5);
        fullValue += nextTrimmed.substring(39, 75);
    };

    return { fullValue: fullValue.trim(), lastLineIndex: continuationIndex };
};

function parseAttributeElement(
    lines: string[],
    lineIndex: number,
    trimmedLine: string,
    components: any,
    lastRecord: string,
    conditionMarker: string
) {
    // Extract with the line's own (unmerged) indicators first — extractAttributes returns an empty
    // array whenever there's no actual keyword text, and only then do we know whether this line is
    // real or a blank/malformed one.
    const { attributes, nextIndex } = extractAttributes('A', lines, lineIndex, true, components.indicators);

    if (attributes.length > 0) {
        const indicators = resolveLineIndicators(conditionMarker, components.indicators);
        attributes.forEach(attr => { attr.indicators = indicators; });

        // Belongs to the record itself (if no field/constant precedes it) or the last field/
        // constant — linkAttributesToParents(), run once the whole document is parsed, sorts that
        // out and merges it into the right parent's own `attributes`.
        const maxLastLineIndex = attributes.reduce(
            (max, attr) => Math.max(max, attr.lastLineIndex ?? lineIndex),
            lineIndex
        );
        const element = {
            kind: 'attribute' as const,
            lineIndex: lineIndex,
            lastLineIndex: maxLastLineIndex,
            value: '',
            indicators: indicators,
            attributes: attributes
        };
        return { element, nextIndex, lastRecord };
    };

    return { element: undefined, nextIndex: lineIndex, lastRecord };
};

/**
 * Parses indicator specifications from a DDS line segment (columns 8-16, 3 groups of 3 chars:
 * N/blank + 2-digit number).
 * @param input - 9-character string containing indicator specifications
 */
export function parseDdsIndicators(input: string): PrtfIndicator[] {
    const indicators: PrtfIndicator[] = [];

    for (let i = 0; i < 3; i++) {
        const segment = input.slice(i * 3, i * 3 + 3);
        const activeChar = segment[0] || ' ';
        const numberStr = segment.slice(1).trim();

        if (numberStr === '') {continue;}

        indicators.push({
            active: activeChar !== 'N',
            number: parseInt(numberStr, 10)
        });
    };

    indicators.sort((a, b) => a.number - b.number);
    return indicators;
};

/**
 * Extracts attribute (keyword) specifications from DDS lines, handling multi-line continuation.
 * @param lineType - Type of line being processed ('R', 'F', 'C', 'A')
 * @param lines - All document lines
 * @param startIndex - Starting line index
 * @param includeIndicators - Whether to include indicator information
 * @param indicators - Indicator objects to associate with the resulting attribute
 */
function extractAttributes(
    lineType: string,
    lines: string[],
    startIndex: number,
    includeIndicators: boolean,
    indicators?: PrtfIndicator[]
): { attributes: PrtfAttribute[]; nextIndex: number } {

    let rawAttributeText = '';
    let currentIndex = startIndex;

    while (currentIndex < lines.length) {
        const line = lines[currentIndex];
        const trimmed = line.substring(5);
        const attributePart = trimmed.substring(39, 75);

        rawAttributeText += attributePart.replace(/-$/, '');

        if (!attributePart.trim().endsWith('-')) {break;}
        currentIndex++;
    };

    rawAttributeText = rawAttributeText.trim();

    if (!rawAttributeText) {
        return { attributes: [], nextIndex: currentIndex };
    };

    // Special handling for constants at the same line index
    if (lineType === 'C' && currentIndex === startIndex) {
        return { attributes: [], nextIndex: currentIndex };
    };

    const attribute: PrtfAttribute = {
        kind: 'attribute',
        lineIndex: startIndex,
        lastLineIndex: currentIndex,
        value: lineType === 'C' ? '' : rawAttributeText,
        indicators: includeIndicators && indicators ? indicators : []
    };

    return { attributes: [attribute], nextIndex: currentIndex };
};

function linkAttributesToParents(prtfElements: PrtfElement[]): void {
    let currentFile: PrtfElement | undefined;
    let currentRecord: PrtfElement | undefined;
    let lastField: PrtfElement | undefined;

    for (const element of prtfElements) {
        switch (element.kind) {
            case 'file':
                currentFile = element;
                currentRecord = undefined;
                lastField = undefined;
                break;

            case 'record':
                currentRecord = element;
                lastField = undefined;
                break;

            case 'field':
            case 'constant':
                lastField = element;
                break;

            case 'attribute':
                if (lastField) {
                    (lastField as any).attributes = [
                        ...((lastField as any).attributes || []),
                        ...(element.attributes || [])
                    ];
                } else if (currentRecord) {
                    (currentRecord as any).attributes = [
                        ...((currentRecord as any).attributes || []),
                        ...(element.attributes || [])
                    ];
                } else if (currentFile) {
                    (currentFile as any).attributes = [
                        ...((currentFile as any).attributes || []),
                        ...(element.attributes || [])
                    ];
                };
                break;
        };
    };
};

/**
 * Reads the first SKIPB(n)/SPACEB(n)/SPACEA(n)/SKIPA(n) — whichever keyword is named — out of a
 * set of attributes. A line's raw attribute value can hold more than one space-separated keyword
 * (e.g. "DATE(*SYS *YY) EDTCDE(Y)"), so this searches within each value rather than matching it
 * whole.
 * @param attributes - The element's own DDS attributes (already fully linked, continuation lines included)
 * @param keyword - One of SKIPB / SPACEB / SPACEA / SKIPA
 */
function extractSkipSpaceValue(attributes: PrtfAttribute[] | undefined, keyword: string): number | undefined {
    for (const attr of attributes ?? []) {
        const match = attr.value.match(new RegExp(`\\b${keyword}\\(\\s*(\\d+)\\s*\\)`, 'i'));
        if (match) {return Number(match[1]);};
    };
    return undefined;
};

/** SKIPB (absolute jump) then SPACEB (relative advance) — processed in that order, before printing. */
function applySkipSpaceBefore(attributes: PrtfAttribute[] | undefined, currentLine: number): number {
    const skipB = extractSkipSpaceValue(attributes, 'SKIPB');
    if (skipB !== undefined) {currentLine = skipB;};
    const spaceB = extractSkipSpaceValue(attributes, 'SPACEB');
    if (spaceB !== undefined) {currentLine += spaceB;};
    return currentLine;
};

/** SPACEA (relative advance) then SKIPA (absolute jump) — processed in that order, after printing. */
function applySkipSpaceAfter(attributes: PrtfAttribute[] | undefined, currentLine: number): number {
    const spaceA = extractSkipSpaceValue(attributes, 'SPACEA');
    if (spaceA !== undefined) {currentLine += spaceA;};
    const skipA = extractSkipSpaceValue(attributes, 'SKIPA');
    if (skipA !== undefined) {currentLine = skipA;};
    return currentLine;
};

export interface FlowSimulationResult {
    /** This record instance's resolved row, per item, keyed by the item's own lineIndex (stable
     * even when the same field/constant is simulated more than once, e.g. a repeated detail row
     * in a composed multi-record preview — each call gets its own fresh Map). */
    rows: Map<number, number>;
    /** The running "current line" coming into each item, keyed by lineIndex — i.e. right before
     * that item's own SKIPB/SPACEB gets a chance to advance it further (so it's the record-level
     * SKIPB/SPACEB result for the first item, or the previous item's own SPACEA/SKIPA result for
     * any other). Used by resolveFlowModeMove to work out what SPACEB delta a dragged item needs
     * to land on a chosen row, measured from wherever things stood coming into it. */
    baselineBefore: Map<number, number>;
    /** The running "current line" after this record's own trailing SPACEA/SKIPA — the starting
     * point for whatever comes next (the next repetition, or the next record in a sequence). */
    endLine: number;
};

/**
 * Simulates one record format's SPACE/SKIP-driven flow positioning: a record-level SKIPB/SPACEB
 * sets the starting line (relative to `startLine`, the incoming "current line"), then each
 * field/constant gets the current line (advanced first by its own SKIPB/SPACEB), and its own
 * SPACEA/SKIPA advances the current line for whatever comes next. Exported so the preview can
 * re-run this with a custom `startLine` when composing several record formats (and repeats of
 * the same one) onto a single page — resolveFlowModePositions below just calls this once per
 * record, in isolation, starting at line 0.
 * @param record - The record format (for its own record-level SPACEB/SPACEA/SKIPB/SKIPA)
 * @param items - Its fields/constants, in source order
 * @param startLine - The "current line" coming in (0 for a record parsed/previewed in isolation)
 */
export function simulateRecordFlow(
    record: PrtfRecord,
    items: (PrtfField | PrtfConstant)[],
    startLine: number
): FlowSimulationResult {
    const rows = new Map<number, number>();
    const baselineBefore = new Map<number, number>();
    let currentLine = applySkipSpaceBefore(record.attributes, startLine);

    for (const item of items) {
        baselineBefore.set(item.lineIndex, currentLine);
        currentLine = applySkipSpaceBefore(item.attributes, currentLine);
        if (currentLine <= 0) {currentLine = 1;};

        rows.set(item.lineIndex, currentLine);

        currentLine = applySkipSpaceAfter(item.attributes, currentLine);
    };

    // The record's own trailing SPACEA/SKIPA — applied once, after all its fields print — is what
    // actually advances a repeating record (e.g. a detail row's record-level SPACEA(1)) to the
    // next line for its next repetition. Irrelevant to `rows` (nothing left in this instance to
    // resolve), only to `endLine`, which is why resolveFlowModePositions below never needed it —
    // there's no "next" to feed when a record is parsed/previewed in isolation.
    currentLine = applySkipSpaceAfter(record.attributes, currentLine);

    return { rows, baselineBefore, endLine: currentLine };
};

/**
 * Normalizes SPACE/SKIP-driven flow positioning to absolute rows, for records that don't use
 * explicit Line/Position at all — the two modes are mutually exclusive per record format (a real
 * CRTPRTF rejects mixing them, confirmed against an actual joblog — see
 * prtf-edit.validation.ts), so this only touches records where no field/constant already resolved
 * an explicit row during the main parsing pass. Must run after linkAttributesToParents, so every
 * element's `attributes` — including ones from separate keyword-only continuation lines — are
 * fully assembled before this reads them.
 */
function resolveFlowModePositions(prtfElements: PrtfElement[]): void {
    const recordElements = prtfElements.filter((el): el is PrtfRecord => el.kind === 'record');

    for (const record of recordElements) {
        const items = prtfElements
            .filter((el): el is PrtfField | PrtfConstant =>
                (el.kind === 'field' || el.kind === 'constant') && el.recordname === record.name)
            .sort((a, b) => a.lineIndex - b.lineIndex);

        if (items.length === 0 || items.some(item => item.positionSource === 'explicit')) {continue;};

        const { rows } = simulateRecordFlow(record, items, 0);
        for (const item of items) {
            item.row = rows.get(item.lineIndex);
            item.positionSource = 'flow';
        };
    };
};

export interface FlowModeInsertionInfo {
    /** True when every existing field/constant in the record is flow-positioned (SPACEB/SPACEA-
     * driven, no Line anywhere) — an empty record, or one with any explicit-Line item, is not. */
    isFlowMode: boolean;
    /** The last existing field/constant's own resolved row, in source order — where a newly
     * appended item's SPACEB(n) needs to count forward from. Only set when isFlowMode is true. */
    lastItemRow?: number;
};

/**
 * Determines whether adding a new field/constant to a record should use SPACEB-driven flow
 * positioning (matching the record's own existing style) instead of an explicit Line — writing an
 * explicit Line into an otherwise flow-mode record is a real CRTPRTF conflict (CPD7826/CPD7860),
 * not just a style mismatch. Used by the "+ Field"/"+ Constant" placing mode; the equivalent check
 * for dragging an existing item lives separately (moveElement).
 * @param elements - The full parsed element list (ExtensionState.lastPrtfElements)
 * @param recordName - The record the new field/constant is being added to
 */
export function resolveFlowModeInsertion(elements: PrtfElement[], recordName: string): FlowModeInsertionInfo {
    const record = elements.find((el): el is PrtfRecord => el.kind === 'record' && el.name === recordName);
    const items = elements
        .filter((el): el is PrtfField | PrtfConstant =>
            (el.kind === 'field' || el.kind === 'constant') && el.recordname === recordName)
        .sort((a, b) => a.lineIndex - b.lineIndex);

    if (!record || items.length === 0 || items.some(item => item.positionSource !== 'flow')) {
        return { isFlowMode: false };
    };

    const { rows } = simulateRecordFlow(record, items, 0);
    const lastItem = items[items.length - 1];
    return { isFlowMode: true, lastItemRow: rows.get(lastItem.lineIndex) ?? 1 };
};

export interface FlowModeMoveInfo {
    /** True when the target item is itself flow-positioned within a fully flow-mode record. */
    isFlowMode: boolean;
    /** The running line coming into this item, before its own SKIPB/SPACEB — the point a new
     * SPACEB(n) needs to count forward from to land the item on a chosen row. Only set when
     * isFlowMode is true. Deliberately *not* clamped to a minimum of 1 here — simulateRecordFlow
     * only clamps the final resolved row (after adding this item's own SPACEB), not the running
     * line coming into it, so clamping this value would silently overstate how much SPACEB is
     * actually needed (off by the clamp) whenever the raw baseline is 0 (typically a record's
     * first item, with no leading record-level SKIPB/SPACEB). */
    baselineRow?: number;
    /** True when the item's own SKIPB (an absolute jump, not a relative advance) already
     * contributes to its row — dragging it vertically isn't supported in that case, since the
     * SPACEB this feature writes only adds on top of wherever SKIPB already jumped to, and
     * resolving the drag target back to "what SKIPB alone would need to be" isn't attempted.
     * Column-only dragging still works, same as a fully non-flow item. */
    hasOwnSkipB?: boolean;
};

/**
 * Determines whether dragging an existing field/constant to a new row should adjust its own
 * SPACEB (matching the record's flow-mode style) instead of rewriting an explicit Line — same
 * reasoning as resolveFlowModeInsertion, applied to an existing item instead of a new one.
 * @param elements - The full parsed element list (ExtensionState.lastPrtfElements)
 * @param recordName - The record the dragged item belongs to
 * @param targetLineIndex - The dragged item's own source line (field) or first line (constant)
 */
export function resolveFlowModeMove(elements: PrtfElement[], recordName: string, targetLineIndex: number): FlowModeMoveInfo {
    const record = elements.find((el): el is PrtfRecord => el.kind === 'record' && el.name === recordName);
    const items = elements
        .filter((el): el is PrtfField | PrtfConstant =>
            (el.kind === 'field' || el.kind === 'constant') && el.recordname === recordName)
        .sort((a, b) => a.lineIndex - b.lineIndex);

    if (!record || items.length === 0 || items.some(item => item.positionSource !== 'flow')) {
        return { isFlowMode: false };
    };

    const targetItem = items.find(item => item.lineIndex === targetLineIndex);
    if (!targetItem) {return { isFlowMode: false };};

    const hasOwnSkipB = (targetItem.attributes ?? []).some(attr => /\bSKIPB\(/i.test(attr.value));

    const { baselineBefore } = simulateRecordFlow(record, items, 0);
    return { isFlowMode: true, baselineRow: baselineBefore.get(targetLineIndex) ?? 0, hasOwnSkipB };
};

/**
 * Removes quotes from a constant's raw name for storage/length purposes — but only when it's
 * actually a quoted literal (a bare DDS system keyword like DATE/TIME/PAGNBR can be coded
 * unquoted in the same position).
 */
function stripConstantQuotes(rawName: string): string {
    return rawName.length >= 2 && rawName.startsWith("'") && rawName.endsWith("'")
        ? rawName.slice(1, -1)
        : rawName;
};

/** Assigns endIndex to each record based on the next record's start or EOF. */
function assignRecordEndIndices(prtfElements: PrtfElement[], totalLines: number): void {
    const recs = (prtfElements.filter(el => el.kind === 'record') as PrtfRecord[])
        .sort((a, b) => a.lineIndex - b.lineIndex);

    for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        const next = recs[i + 1];
        rec.endIndex = next ? next.lineIndex - 1 : totalLines - 1; // inclusive range
    };
};

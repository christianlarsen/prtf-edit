/*
  Christian Larsen, 2026
  "PRTF structure"
  prtf-edit.model.ts
*/

/**
 * Represents any possible parsed DDS element type for a printer file.
 */
export type PrtfElement =
  | PrtfFile
  | PrtfRecord
  | PrtfAttribute
  | PrtfField
  | PrtfConstant;

/**
 * Represents a general DDS attribute (keyword) line. Stored as raw text (e.g. "SPACEA(1)
 * UNDERLINE") rather than split into individual keyword nodes — consumers grep this for the
 * specific keyword they care about, same approach dspf-edit uses.
 */
export interface PrtfAttribute {
  kind: 'attribute';
  lineIndex: number;
  lastLineIndex?: number;
  value: string;
  indicators?: PrtfIndicator[];
  /** Every physical source line that contributed to `indicators`, in order — every indicator-only
   * continuation line consumed before this one, then this line's own index last (indicator
   * continuation lines precede, rather than follow, the line they condition — see
   * resolveLineIndicators in the parser). Undefined when there are no indicators at all. Lets a
   * write-back command find exactly which lines to rewrite/remove without re-deriving the parser's
   * own accumulation logic. */
  indicatorLineIndices?: number[];
  /** Set on the wrapper 'attribute' element the parser emits per source line: the actual
   * keyword attribute(s) found on that line, later merged into the parent's own `attributes`. */
  attributes?: PrtfAttribute[];
};

/**
 * Represents an indicator (e.g., *IN01).
 */
export interface PrtfIndicator {
  active: boolean;
  number: number;
  /** Zero-based AND-group index, for elements conditioned by more than one OR'd group of
   * indicators (continued across lines) — see groupIndicatorsByCondition. */
  group?: number;
};

/**
 * Splits a flat, group-tagged indicator array back into its OR'd AND-groups, in group order.
 * Mirrors dspf-edit's model so downstream consumers (tree labels, tooltips) agree on the same
 * grouping.
 * @param indicators - The element's indicators, possibly spanning several OR'd AND-groups
 */
export function groupIndicatorsByCondition(indicators?: PrtfIndicator[]): PrtfIndicator[][] {
  if (!indicators || indicators.length === 0) {return [];}

  const groups = new Map<number, PrtfIndicator[]>();
  for (const ind of indicators) {
    const key = ind.group ?? 0;
    const group = groups.get(key);
    if (group) {group.push(ind);} else {groups.set(key, [ind]);}
  };

  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
};

/**
 * True when a constant's keyword-zone text (columns 45-80) is a quoted literal ('text' or
 * X'hex') rather than a bare system keyword invocation (DATE, TIME, PAGNBR, ...). Constants with
 * no quoted literal print a system-supplied value at run time — see "Constant fields in printer
 * files" in the DDS reference.
 * @param value - The raw (untrimmed-of-quotes) constant text
 */
export function isLiteralConstantValue(value: string): boolean {
  return value.startsWith("'") || /^X'/i.test(value);
};

/**
 * Approximate printed value for a bare system-keyword constant (DATE/TIME/PAGNBR — no quoted
 * literal), shared by the parser (to estimate "+n" relative-position chaining) and the preview
 * (as placeholder text) so the two stay in sync. Not exact — the real value depends on job
 * DATFMT/TIMFMT/EDTCDE at print time — just a representative stand-in, same spirit as the O/6
 * field placeholders.
 * @param attributeValue - One field/constant attribute's raw value text
 */
export function systemKeywordPlaceholder(attributeValue: string): string | undefined {
  const upper = attributeValue.toUpperCase();
  if (upper === 'DATE' || upper.startsWith('DATE(')) {return 'DD-DD-DD';};
  if (upper === 'TIME' || upper.startsWith('TIME(')) {return 'TT:TT:TT';};
  // 9999 (not a plausible "page 1"), matching RLU's own "fill with the widest possible value"
  // design-view convention — the page count never grows past 9999 anyway (see the PAGNBR
  // reference), so this doubles as the field's true worst case, not just an arbitrary choice.
  // PAGNBR takes no parameters of its own, so (unlike DATE/TIME's own `KEYWORD(` check) a bare
  // trailing space is what tolerates another keyword coded on the same line (e.g. "PAGNBR
  // EDTCDE(Y)") without over-matching an unrelated word that merely starts with "PAGNBR".
  if (upper === 'PAGNBR' || upper.startsWith('PAGNBR ')) {return '9999';};
  return undefined;
};

/**
 * Extracts a field/constant/record's TEXT() keyword description, if present — pure DDS
 * documentation with no runtime effect, surfaced as a hover tooltip in the preview.
 * @param attributes - The element's own DDS attributes
 */
export function findTextKeyword(attributes: PrtfAttribute[] | undefined): string | undefined {
  for (const attr of attributes ?? []) {
    const match = attr.value.match(/\bTEXT\(\s*'((?:[^']|'')*)'\s*\)/i);
    if (match) {return match[1].replace(/''/g, "'");};
  };
  return undefined;
};

// ELEMENT-SPECIFIC INTERFACES

/** DDS File element */
export interface PrtfFile {
  kind: 'file';
  lineIndex: number;
  attributes?: PrtfAttribute[];
  children?: PrtfElement[];
};

/** DDS Record element */
export interface PrtfRecord {
  kind: 'record';
  name: string;
  lineIndex: number;
  endIndex?: number;
  children?: PrtfElement[];
  attributes?: PrtfAttribute[];
};

/**
 * DDS Field element. Unlike DSPF, a printer file field has no input/hidden usage — position 38
 * (Usage) is only ever blank/O (output) or P (program-to-system: a field that never prints, only
 * feeds another keyword's parameter at runtime, e.g. AFPRSC's resource-name).
 */
export interface PrtfField {
  kind: 'field';
  name: string;
  type?: string;
  length?: number;
  decimals?: number;
  usage: string;
  programToSystem: boolean;
  /** Absolute line (row), resolved from either an explicit Line entry or "blank = same row as the
   * preceding field/constant in this record". Undefined when the record uses SPACE/SKIP-driven
   * flow positioning instead of explicit Line/Position (no line number given at all). */
  row?: number;
  /** Absolute column, resolved the same way — a "+n" Position entry is n spaces after the end of
   * the preceding field/constant. */
  column?: number;
  /** How `row` was resolved: 'explicit' from an actual Line entry (or blank-row inheritance
   * within an explicit-mode record); 'flow' from simulating this record's SPACEB/SPACEA/SKIPB/
   * SKIPA keywords (no Line anywhere in the record — see resolveFlowModePositions in the parser).
   * Undefined when `row` itself is still unresolved. The two modes are mutually exclusive per
   * record format (see prtf-edit.validation.ts) — this lets consumers that only care about real
   * compile errors (the validator) tell them apart from each other. */
  positionSource?: 'explicit' | 'flow';
  referenced?: boolean;
  /** For a referenced field: the field/file/library its type/length/decimals are borrowed from,
   * parsed from its REFFLD() keyword (or, absent one, its own name in an R-flagged field). */
  refTarget?: { fieldName: string; file?: string; library?: string; recordFormat?: string };
  lineIndex: number;
  recordname: string;
  attributes?: PrtfAttribute[];
  indicators?: PrtfIndicator[];
  /** See the same field on PrtfAttribute. */
  indicatorLineIndices?: number[];
};

/** DDS Constant element (unnamed field, or *NONE when POSITION keyword is used) */
export interface PrtfConstant {
  kind: 'constant';
  name: string;
  row: number;
  column: number;
  /** How `row` was resolved — see the same field on PrtfField. */
  positionSource?: 'explicit' | 'flow';
  lineIndex: number;
  lastLineIndex: number;
  recordname: string;
  attributes?: PrtfAttribute[];
  /** See the same field on PrtfAttribute. */
  indicatorLineIndices?: number[];
  indicators?: PrtfIndicator[];
};


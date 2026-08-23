/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-attributes.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { isEmptyKeywordOnlyLine, recordAttrsAnchorLineIndex } from './prtf-edit.move-element';
import { findTextKeyword, PrtfAttribute, PrtfRecord } from '../prtf-edit.model/prtf-edit.model';
import { COLOR_NAMES, EDIT_CODES, parseEdtcde } from '../prtf-edit.webview/prtf-edit.record-preview-panel';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';

/** Positions 45-80 (36 chars) hold the keyword zone on any one line — same limit add-constant.ts
 * uses for a constant's own literal. TEXT() is documentation-only with no runtime effect, so it
 * isn't worth the continuation-line machinery add-constant.ts needs for a printed literal — this
 * just rejects (not silently truncates) a description that doesn't fit one line. */
const KEYWORD_ZONE_WIDTH = 36;

const UNDERLINE_PATTERN = /\s?\bUNDERLINE\b/i;
const HIGHLIGHT_PATTERN = /\s?\bHIGHLIGHT\b/i;
const COLOR_PATTERN = /\s?\bCOLOR\(\s*[^)]*\)/i;
const EDTCDE_PATTERN = /\s?\bEDTCDE\(\s*[^)]*\)/i;
const TEXT_PATTERN = /\s?\bTEXT\(\s*'(?:[^']|'')*'\s*\)/i;
/** Record-level only — an unconditional page eject right after that record prints (see
 * hasEndPage, record-preview-panel.ts). */
const ENDPAGE_PATTERN = /\s?\bENDPAGE\b/i;
/** FONT's own parameter can itself carry a nested `(*POINTSIZE h w)` group — one level of nesting
 * (`\([^()]*\)`) is as far as the real keyword ever goes, so a flat `[^)]*` (fine for COLOR/EDTCDE,
 * which never nest) would stop at the *inner* close-paren and truncate the match. The left
 * boundary is `\b` OR "immediately preceded by a digit" — same reasoning as edit-spacing.ts's own
 * keywordPattern: a fixed-column Position value often abuts the keyword zone with no space (e.g.
 * the DDS reference's own "20CHRID" example), where plain `\b` (digit and letter are both "word"
 * characters to it) would miss the boundary entirely. Capture group 1 is the raw inner text, for
 * prefilling the edit box. */
const FONT_PATTERN = /\s?(?:\b|(?<=\d))FONT\(((?:[^()]|\([^()]*\))*)\)/i;
/** Field-level only, no parameters — like HIGHLIGHT/UNDERLINE, but with the same digit-boundary
 * trick as FONT_PATTERN: the DDS reference's own CHRID example ("20CHRID") abuts a Position digit
 * directly with no space. */
const CHRID_PATTERN = /\s?(?:\b|(?<=\d))CHRID\b/i;

/** The minimal shape applyOrInsertKeyword actually needs — anything with a primary line, an
 * optional last-line anchor for appending a new continuation line, and its own attribute list.
 * A field/constant (AttributeItem) satisfies this structurally, and so does a record (via a small
 * anchor object built from recordAttrsAnchorLineIndex — see editRecordAttributes). */
type KeywordHost = {
	lineIndex: number;
	lastLineIndex?: number;
	attributes?: { value: string; lineIndex: number }[];
};

type AttributeItem = KeywordHost & {
	kind: 'field' | 'constant';
	name: string;
	type?: string;
	recordname: string;
};

function hasFlag(attributes: KeywordHost['attributes'], pattern: RegExp): boolean {
	return (attributes ?? []).some(attr => pattern.test(attr.value));
};

/**
 * True for a constant carrying a bare PAGNBR keyword (see systemKeywordPlaceholder in
 * prtf-edit.model.ts) — the one constant-level system keyword DDS lets EDTCDE apply to (a page
 * number is inherently numeric); DATE/TIME use their own DATFMT/TIMFMT instead and don't take
 * EDTCDE at all, so this deliberately doesn't extend to every system-keyword constant.
 */
function isPagnbrConstant(item: AttributeItem): boolean {
	if (item.kind !== 'constant') {return false;};
	return (item.attributes ?? []).some(attr => /^PAGNBR\b/i.test(attr.value.trim()));
};

/** Current COLOR() parameter, whatever it is — including a device-calibrated form (RGB/CMYK/...)
 * this extension doesn't render or offer in its own picker, so a replace still finds and overwrites
 * it correctly even though it was never one of COLOR_NAMES' own keys. */
function currentColorCode(attributes: AttributeItem['attributes']): string | undefined {
	for (const attr of attributes ?? []) {
		const match = attr.value.match(/\bCOLOR\(\s*([^)\s]+)/i);
		if (match) {return match[1].toUpperCase();};
	};
	return undefined;
};

/** Current FONT(...) parameter text, raw (whatever the user last typed — numeric ID, graphic font
 * name, *VECTOR, optionally with a trailing `(*POINTSIZE h w)`) — no attempt to parse or validate
 * its shape, matching the free-text edit box this feeds (same "documentation-only, edited as
 * plain text" spirit as TEXT, since the preview's monospace grid can't render an actual typeface
 * to check the value against). */
function currentFontValue(attributes: KeywordHost['attributes']): string | undefined {
	for (const attr of attributes ?? []) {
		const match = attr.value.match(FONT_PATTERN);
		if (match) {return match[1].trim();};
	};
	return undefined;
};

/**
 * True when a FONT(...) value names a graphic font (an alphanumeric name, or *VECTOR) rather than
 * a numeric hardware font ID — the distinction the DDS reference's CHRID keyword actually cares
 * about: "FONT(graphic-font-name) and CHRID cannot apply to the same field" (a numeric FONT is
 * fine alongside CHRID; CHRID is simply ignored, not rejected, when a graphic FONT is in effect —
 * but there's no way for this editor to write a keyword combination it already knows is a no-op).
 * @param fontValue - The raw text between FONT( and its closing paren (see currentFontValue) —
 *   e.g. "222", "ADMMVSS", "*VECTOR", or "222 (*POINTSIZE 10.0)".
 */
function isGraphicFontName(fontValue: string): boolean {
	const identifier = fontValue.replace(/\(\s*\*POINTSIZE[^)]*\)\s*$/i, '').trim();
	return !/^\d+$/.test(identifier);
};

function edtcdeDescription(code: string): string {
	const info = EDIT_CODES[code];
	if (!info) {return '';};
	const sign = info.sign === 'suffixCr' ? 'trailing CR' : info.sign === 'suffixMinus' ? 'trailing -'
		: info.sign === 'prefixMinus' ? 'leading -' : 'no sign';
	return `${info.commas ? 'commas' : 'no commas'}, ${sign}`;
};

/**
 * Replaces an existing occurrence of `pattern` on whichever line it's on — the item's own
 * primary line, or a dedicated keyword-only continuation line (deleted outright if that removal
 * leaves it empty) — or, when there's no existing occurrence and a value is being set, appends a
 * brand-new continuation line. Mirrors editSpacing's own three-way branch in
 * prtf-edit.edit-spacing.ts, generalized from a single numeric-valued keyword to any keyword shape
 * (flag-only, quoted-literal, or named-parameter).
 * @param pattern - Matches the keyword (with its value, if any) anywhere it occurs on a line, plus
 *   one optional leading whitespace character so removing it doesn't leave a stray double space.
 * @param newRawKeywordText - The full replacement keyword text (e.g. "COLOR(RED)", "HIGHLIGHT",
 *   "TEXT('foo')"), or undefined to remove the keyword entirely.
 */
export function applyOrInsertKeyword(
	document: vscode.TextDocument,
	edit: vscode.WorkspaceEdit,
	item: KeywordHost,
	pattern: RegExp,
	newRawKeywordText: string | undefined
): void {
	const existingAttr = (item.attributes ?? []).find(attr => pattern.test(attr.value));
	const replacement = newRawKeywordText !== undefined ? ` ${newRawKeywordText}` : '';

	if (existingAttr && existingAttr.lineIndex === item.lineIndex) {
		const primaryLine = document.lineAt(item.lineIndex);
		edit.replace(document.uri, primaryLine.range, primaryLine.text.replace(pattern, replacement));
	} else if (existingAttr) {
		const keywordLine = document.lineAt(existingAttr.lineIndex);
		const updatedText = keywordLine.text.replace(pattern, replacement);
		if (newRawKeywordText === undefined && isEmptyKeywordOnlyLine(updatedText)) {
			edit.delete(document.uri, keywordLine.rangeIncludingLineBreak);
		} else {
			edit.replace(document.uri, keywordLine.range, updatedText);
		};
	} else if (newRawKeywordText !== undefined) {
		const anchorLineIndex = item.lastLineIndex ?? item.lineIndex;
		const insertPosition = document.lineAt(anchorLineIndex).range.end;
		const newLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + newRawKeywordText;
		edit.insert(document.uri, insertPosition, '\n' + newLine);
	};
	// Nothing existing and nothing to set — no-op.
};

/**
 * Lets the user set or clear one appearance keyword — TEXT, COLOR, HIGHLIGHT, UNDERLINE, or (for a
 * numeric field only) EDTCDE — on the field/constant selected in the preview. One keyword per
 * invocation, same UX as the existing "Edit spacing" (right-click): a QuickPick lists the options
 * with their current value, picking one prompts for the new value (or just toggles, for the two
 * flag keywords), then applies and closes. All five are keywords the preview already knows how to
 * *render* (COLOR/HIGHLIGHT/UNDERLINE are painted directly; EDTCDE shapes a numeric field's edited
 * placeholder width; TEXT shows as a hover tooltip) — this is what makes them editable too, rather
 * than only settable by hand-editing the DDS source.
 * @param lineIndex - Zero-based source line of the field/constant to edit
 */
export async function editAttributes(lineIndex: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const item = ExtensionState.lastPrtfElements.find((e: any) =>
		(e.kind === 'field' || e.kind === 'constant') && e.lineIndex === lineIndex) as AttributeItem | undefined;
	if (!item) {return;}

	const isNumericField = item.kind === 'field' && (item.type === 'S' || item.type === 'F');
	const isPagnbr = isPagnbrConstant(item);
	const currentText = findTextKeyword(item.attributes as PrtfAttribute[] | undefined);
	const currentColor = currentColorCode(item.attributes);
	const currentEdtcde = parseEdtcde(item.attributes as PrtfAttribute[] | undefined);
	const currentFont = currentFontValue(item.attributes);
	const highlightOn = hasFlag(item.attributes, HIGHLIGHT_PATTERN);
	const underlineOn = hasFlag(item.attributes, UNDERLINE_PATTERN);
	const chridOn = hasFlag(item.attributes, CHRID_PATTERN);
	// A field with no FONT of its own still inherits its record's — if that's a graphic font name,
	// CHRID is just as ineffective on this field as if it had that same FONT directly (see
	// isGraphicFontName's own doc comment).
	const record = ExtensionState.lastPrtfElements.find((e: any) => e.kind === 'record' && e.name === item.recordname) as PrtfRecord | undefined;
	const effectiveFont = currentFont ?? currentFontValue(record?.attributes);

	// Note: the choice's own discriminator is named `attrKind`, not `kind` — QuickPickItem already
	// declares a `kind` property of its own (QuickPickItemKind, used for separators), which a same-
	// named custom field would collide with.
	const choices: { label: string; description: string; attrKind: 'TEXT' | 'COLOR' | 'HIGHLIGHT' | 'UNDERLINE' | 'EDTCDE' | 'FONT' | 'CHRID' }[] = [
		{ label: 'TEXT', description: currentText ? `"${currentText}"` : '(not set)', attrKind: 'TEXT' },
		{ label: 'COLOR', description: currentColor ?? '(none)', attrKind: 'COLOR' },
		{ label: 'HIGHLIGHT', description: highlightOn ? 'on' : 'off', attrKind: 'HIGHLIGHT' },
		{ label: 'UNDERLINE', description: underlineOn ? 'on' : 'off', attrKind: 'UNDERLINE' },
		{ label: 'FONT', description: currentFont ? `(${currentFont})` : '(none)', attrKind: 'FONT' },
	];
	if (isNumericField || isPagnbr) {
		choices.push({ label: 'EDTCDE', description: currentEdtcde ? currentEdtcde.code + (currentEdtcde.currency ? ` ${currentEdtcde.currency}` : '') : '(none)', attrKind: 'EDTCDE' });
	};
	// Not valid on constant fields or numeric fields (DDS reference, CHRID keyword).
	if (item.kind === 'field' && !isNumericField) {
		choices.push({ label: 'CHRID', description: chridOn ? 'on' : 'off', attrKind: 'CHRID' });
	};

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: `Edit an attribute of '${item.name}'` });
	if (!picked) {return;}

	const edit = new vscode.WorkspaceEdit();

	if (picked.attrKind === 'TEXT') {
		const input = await vscode.window.showInputBox({
			prompt: `TEXT('...') — documentation only, no runtime effect. Leave blank to remove.`,
			value: currentText ?? '',
			validateInput: value => {
				const rawLength = `TEXT('${value.replace(/'/g, "''")}')`.length;
				return rawLength > KEYWORD_ZONE_WIDTH ? `Too long to fit on one line (${rawLength}/${KEYWORD_ZONE_WIDTH} characters).` : undefined;
			}
		});
		if (input === undefined) {return;} // Cancelled.
		const newRaw = input === '' ? undefined : `TEXT('${input.replace(/'/g, "''")}')`;
		if (newRaw === undefined && currentText === undefined) {return;} // Nothing to remove.
		applyOrInsertKeyword(document, edit, item, TEXT_PATTERN, newRaw);

	} else if (picked.attrKind === 'COLOR') {
		const colorChoices = [
			{ label: '(none)', code: undefined as string | undefined },
			...Object.keys(COLOR_NAMES).map(code => ({ label: code, code }))
		];
		const colorPicked = await vscode.window.showQuickPick(colorChoices, { placeHolder: 'Choose a color' });
		if (!colorPicked) {return;} // Cancelled.
		if (colorPicked.code === undefined && currentColor === undefined) {return;} // Nothing to remove.
		applyOrInsertKeyword(document, edit, item, COLOR_PATTERN, colorPicked.code ? `COLOR(${colorPicked.code})` : undefined);

	} else if (picked.attrKind === 'HIGHLIGHT') {
		applyOrInsertKeyword(document, edit, item, HIGHLIGHT_PATTERN, highlightOn ? undefined : 'HIGHLIGHT');

	} else if (picked.attrKind === 'UNDERLINE') {
		applyOrInsertKeyword(document, edit, item, UNDERLINE_PATTERN, underlineOn ? undefined : 'UNDERLINE');

	} else if (picked.attrKind === 'FONT') {
		const input = await vscode.window.showInputBox({
			prompt: `FONT(...) — a numeric font ID, a graphic font name, or *VECTOR, optionally followed by (*POINTSIZE height width). Leave blank to remove.`,
			value: currentFont ?? '',
			validateInput: value => {
				const rawLength = `FONT(${value})`.length;
				return rawLength > KEYWORD_ZONE_WIDTH ? `Too long to fit on one line (${rawLength}/${KEYWORD_ZONE_WIDTH} characters).` : undefined;
			}
		});
		if (input === undefined) {return;} // Cancelled.
		const newRaw = input === '' ? undefined : `FONT(${input})`;
		if (newRaw === undefined && currentFont === undefined) {return;} // Nothing to remove.
		if (newRaw !== undefined && chridOn && isGraphicFontName(input)) {
			vscode.window.showErrorMessage(`PRTF: '${item.name}' already has CHRID — FONT('${input}') is a graphic font name, and CHRID and a graphic FONT can't apply to the same field. Remove CHRID first, or use a numeric font ID instead.`);
			return;
		};
		applyOrInsertKeyword(document, edit, item, FONT_PATTERN, newRaw);

	} else if (picked.attrKind === 'CHRID') {
		if (!chridOn && effectiveFont !== undefined && isGraphicFontName(effectiveFont)) {
			vscode.window.showErrorMessage(`PRTF: can't enable CHRID on '${item.name}' — it ${currentFont ? '' : `inherits from '${item.recordname}' `}a graphic FONT('${effectiveFont}'), and CHRID and a graphic FONT can't apply to the same field. Give it a numeric FONT (or remove FONT) first.`);
			return;
		};
		applyOrInsertKeyword(document, edit, item, CHRID_PATTERN, chridOn ? undefined : 'CHRID');

	} else if (picked.attrKind === 'EDTCDE') {
		const codeChoices = [
			{ label: '(none)', code: undefined as string | undefined },
			...Object.keys(EDIT_CODES).map(code => ({ label: code, description: edtcdeDescription(code), code }))
		];
		const codePicked = await vscode.window.showQuickPick(codeChoices, { placeHolder: 'Choose an edit code' });
		if (!codePicked) {return;} // Cancelled.

		if (codePicked.code === undefined) {
			if (currentEdtcde === undefined) {return;} // Nothing to remove.
			applyOrInsertKeyword(document, edit, item, EDTCDE_PATTERN, undefined);
		} else {
			const currency = await vscode.window.showInputBox({
				prompt: `Optional: '*' for asterisk-fill, or a single currency symbol — leave blank for none`,
				value: currentEdtcde?.code === codePicked.code ? (currentEdtcde.currency ?? '') : '',
				validateInput: value => value.length > 1 ? 'One character, or leave blank.' : undefined
			});
			if (currency === undefined) {return;} // Cancelled.
			const raw = currency === '' ? `EDTCDE(${codePicked.code})` : `EDTCDE(${codePicked.code} ${currency})`;
			applyOrInsertKeyword(document, edit, item, EDTCDE_PATTERN, raw);
		};
	};

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the change — the document may be read-only.');
	};
};

/** Adapter for the "Definition" tree's context-menu entry (package.json's view/item/context,
 * restricted to field/constant nodes via viewItem) — editAttributes itself only needs a lineIndex,
 * so this just unwraps it from whichever node was right-clicked. */
export function editAttributesFromNode(node: PrtfNode): void {
	if (!node || (node.source.kind !== 'field' && node.source.kind !== 'constant')) {return;}
	void editAttributes(node.source.lineIndex);
};

/**
 * Lets the user set or clear one of a record format's own appearance keywords — HIGHLIGHT (bolds
 * every field/constant in the record that doesn't already override it), ENDPAGE (an unconditional
 * page eject right after this record prints), or FONT (the default font for every field in the
 * record, same free-text edit as field-level FONT — see editAttributes) — the only ones the
 * preview actually renders or otherwise understands at record level (unlike a field/constant, a
 * record has no TEXT/COLOR/UNDERLINE/EDTCDE/CHRID of its own). Reuses applyOrInsertKeyword via a
 * small anchor object, since a record has no single lastLineIndex field of its own the way a
 * field/constant does.
 */
export async function editRecordAttributes(record: PrtfRecord): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const highlightOn = hasFlag(record.attributes, HIGHLIGHT_PATTERN);
	const endPageOn = hasFlag(record.attributes, ENDPAGE_PATTERN);
	const currentFont = currentFontValue(record.attributes);

	const choices: { label: string; description: string; attrKind: 'HIGHLIGHT' | 'ENDPAGE' | 'FONT' }[] = [
		{ label: 'HIGHLIGHT', description: highlightOn ? 'on' : 'off', attrKind: 'HIGHLIGHT' },
		{ label: 'ENDPAGE', description: endPageOn ? 'on' : 'off', attrKind: 'ENDPAGE' },
		{ label: 'FONT', description: currentFont ? `(${currentFont})` : '(none)', attrKind: 'FONT' },
	];

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: `Edit an attribute of '${record.name}'` });
	if (!picked) {return;}

	const edit = new vscode.WorkspaceEdit();
	const anchor: KeywordHost = { lineIndex: record.lineIndex, lastLineIndex: recordAttrsAnchorLineIndex(record), attributes: record.attributes };

	if (picked.attrKind === 'HIGHLIGHT') {
		applyOrInsertKeyword(document, edit, anchor, HIGHLIGHT_PATTERN, highlightOn ? undefined : 'HIGHLIGHT');
	} else if (picked.attrKind === 'ENDPAGE') {
		applyOrInsertKeyword(document, edit, anchor, ENDPAGE_PATTERN, endPageOn ? undefined : 'ENDPAGE');
	} else {
		const input = await vscode.window.showInputBox({
			prompt: `FONT(...) — a numeric font ID, a graphic font name, or *VECTOR, optionally followed by (*POINTSIZE height width). Leave blank to remove.`,
			value: currentFont ?? '',
			validateInput: value => {
				const rawLength = `FONT(${value})`.length;
				return rawLength > KEYWORD_ZONE_WIDTH ? `Too long to fit on one line (${rawLength}/${KEYWORD_ZONE_WIDTH} characters).` : undefined;
			}
		});
		if (input === undefined) {return;} // Cancelled.
		const newRaw = input === '' ? undefined : `FONT(${input})`;
		if (newRaw === undefined && currentFont === undefined) {return;} // Nothing to remove.
		if (newRaw !== undefined && isGraphicFontName(input)) {
			// A graphic FONT set here cascades to every field in the record that doesn't override it
			// with its own numeric FONT — CHRID on any such field would silently stop working (see
			// isGraphicFontName's own doc comment), so this needs the same block field-level FONT
			// already gets, just checked across every field instead of just one.
			const conflictingField = (ExtensionState.lastPrtfElements as any[]).find(e =>
				e.kind === 'field' && e.recordname === record.name && hasFlag(e.attributes, CHRID_PATTERN) &&
				!(currentFontValue(e.attributes) !== undefined && !isGraphicFontName(currentFontValue(e.attributes)!))
			);
			if (conflictingField) {
				vscode.window.showErrorMessage(`PRTF: can't set a graphic FONT('${input}') on '${record.name}' — field '${conflictingField.name}' has CHRID with no numeric FONT of its own to override it, and CHRID and a graphic FONT can't apply to the same field. Give that field a numeric FONT (or remove its CHRID) first.`);
				return;
			};
		};
		applyOrInsertKeyword(document, edit, anchor, FONT_PATTERN, newRaw);
	};

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the change — the document may be read-only.');
	};
};

export function editRecordAttributesFromNode(node: PrtfNode): void {
	if (!node || node.source.kind !== 'record') {return;}
	void editRecordAttributes(node.source as PrtfRecord);
};

export function registerEditAttributesCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.edit-attributes', editAttributesFromNode),
		vscode.commands.registerCommand('prtf-edit.edit-record-attributes', editRecordAttributesFromNode)
	);
};

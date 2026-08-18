/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.add-constant.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { resolveFlowModeInsertion } from '../prtf-edit.parser/prtf-edit.parser';

/** Positions 45-80 (36 chars) hold the keyword/constant text on any one line. */
const KEYWORD_ZONE_WIDTH = 36;
/** A continuation line's usable content is one column short of the full zone width — the last
 * column is reserved for the trailing '-' continuation marker itself (see buildConstantLines). */
const CONTINUATION_CONTENT_WIDTH = KEYWORD_ZONE_WIDTH - 1;
/** Sanity cap on total literal length — DDS quoted literals can run long, but this is generous
 * enough for real report text while still catching a runaway paste. Also reused by
 * edit-constant-text.ts's own text prompt. */
export const MAX_CONSTANT_TEXT_LENGTH = 500;

/**
 * Builds one or more source lines for a new constant, splitting the quoted literal across DDS's
 * own keyword-continuation convention when it doesn't fit in one line's 36-column keyword zone
 * (columns 45-80): a trailing '-' marks "the value continues on the next line's own keyword
 * zone" — the same convention the parser's own extractMultiLineConstant already reads back (see
 * prtf-edit.parser.ts), so a constant added this way round-trips correctly. The dash itself isn't
 * part of the value; it costs one column, leaving 35 usable characters on every continuation line
 * (the first line and the final one aren't dash-constrained the same way — the first still has to
 * share its zone with the opening quote, and the closing quote lands wherever the last chunk
 * ends). Only the first line carries the Line/Position entry (columns 39-44); every continuation
 * line is a bare keyword-only line, same shape as any other multi-line DDS attribute in this
 * codebase (e.g. a field's TEXT() on its own following line). Embedded single quotes are doubled,
 * DDS's own literal-escaping convention, before splitting.
 *
 * `row` is `undefined` for a flow-mode target record (Line stays blank, matching the record's
 * existing SPACEB/SPACEA style — writing an explicit Line there would be a real CRTPRTF conflict);
 * in that case a `spaceBefore` count greater than 0 appends one more keyword-only SPACEB(n) line
 * after the literal, positioning the new constant relative to whatever printed immediately before it.
 * @param row - DDS line number (1-based), or undefined for a flow-mode record
 * @param col - DDS position (1-based)
 * @param text - The literal text to print (unescaped — embedded quotes are doubled here)
 * @param spaceBefore - Lines to advance past the previous item via SPACEB — only used when row is undefined
 */
export function buildConstantLines(row: number | undefined, col: number, text: string, spaceBefore?: number): string[] {
	const prefix = ' '.repeat(5) + 'A' + ' '.repeat(32); // columns 1-38
	const rowText = row !== undefined ? String(row).padStart(3, ' ') : '   ';
	const colText = String(col).padStart(3, ' ');
	const positionPrefix = `${prefix}${rowText}${colText}`; // columns 1-44
	// Same form-type 'A' in column 6 as every other line, position/name zone otherwise blank —
	// matches how every other multi-line DDS attribute in this codebase is written.
	const continuationPrefix = ' '.repeat(5) + 'A' + ' '.repeat(38);

	const fullQuoted = `'${text.replace(/'/g, "''")}'`;

	const lines: string[] = [];

	if (fullQuoted.length <= KEYWORD_ZONE_WIDTH) {
		lines.push(`${positionPrefix}${fullQuoted}`);
	} else {
		let remaining = fullQuoted;
		let isFirstLine = true;

		while (remaining.length > KEYWORD_ZONE_WIDTH) {
			const chunk = remaining.slice(0, CONTINUATION_CONTENT_WIDTH) + '-';
			lines.push(`${isFirstLine ? positionPrefix : continuationPrefix}${chunk}`);
			remaining = remaining.slice(CONTINUATION_CONTENT_WIDTH);
			isFirstLine = false;
		};
		lines.push(`${isFirstLine ? positionPrefix : continuationPrefix}${remaining}`);
	};

	if (row === undefined && spaceBefore !== undefined && spaceBefore > 0) {
		lines.push(`${continuationPrefix}SPACEB(${spaceBefore})`);
	};

	return lines;
};

/**
 * Adds a new constant to a record at the given (row, col) — used by the preview's "+ Constant"
 * placing mode. Prompts for the literal text, then appends the new line right after the
 * record's current last line (position is explicit either way, so where in the source it lands
 * doesn't affect how it renders).
 * @param recordName - Record to add the constant to
 * @param row - DDS line number (1-based)
 * @param col - DDS position (1-based)
 * @param maxRow - Upper bound to clamp row to (the preview's configured page rows)
 * @param maxCol - Upper bound to clamp col to (the preview's configured page cols)
 */
export async function addConstantAt(recordName: string, row: number, col: number, maxRow: number, maxCol: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const record = ExtensionState.lastPrtfElements.find((e: any) => e.kind === 'record' && e.name === recordName) as { endIndex?: number; lineIndex: number } | undefined;
	if (!record) {return;}

	const text = await vscode.window.showInputBox({
		prompt: `New constant at line ${row}, position ${col}`,
		placeHolder: 'Text to print',
		validateInput: value => value.length > MAX_CONSTANT_TEXT_LENGTH
			? `Too long — max ${MAX_CONSTANT_TEXT_LENGTH} characters.`
			: undefined
	});
	if (!text) {return;} // Cancelled or left blank.

	const clampedRow = Math.min(Math.min(255, maxRow), Math.max(1, Math.round(row)));
	const clampedCol = Math.min(Math.min(255, maxCol), Math.max(1, Math.round(col)));

	const flowInfo = resolveFlowModeInsertion(ExtensionState.lastPrtfElements, recordName);
	const newLines = flowInfo.isFlowMode
		? buildConstantLines(undefined, clampedCol, text, Math.max(0, clampedRow - (flowInfo.lastItemRow ?? 1)))
		: buildConstantLines(clampedRow, clampedCol, text);

	const anchorLineIndex = record.endIndex ?? record.lineIndex;
	const insertPosition = document.lineAt(anchorLineIndex).range.end;

	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, insertPosition, '\n' + newLines.join('\n'));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage('PRTF: constant added.');
	} else {
		vscode.window.showErrorMessage('PRTF: could not add the constant — the document may be read-only.');
	};
};

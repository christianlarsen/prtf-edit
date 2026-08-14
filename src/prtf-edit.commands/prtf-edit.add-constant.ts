/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.add-constant.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';

/** Positions 45-80 (36 chars) hold the keyword/constant text; a quoted literal needs 2 of those
 * for the quotes, so this is the longest single-line constant text this command supports.
 * Longer text would need DDS's keyword-continuation convention (trailing '-'), not implemented
 * here — see the project roadmap. */
const MAX_CONSTANT_TEXT_LENGTH = 34;

/**
 * Builds a new constant source line: blank name/type zone (columns 1-38, form type 'A' in column
 * 6, matching the file's own convention), explicit Line/Position (39-44), and the quoted literal
 * in the keyword zone. Embedded single quotes are doubled, DDS's own literal-escaping convention.
 */
export function buildConstantLine(row: number, col: number, text: string): string {
	const prefix = ' '.repeat(5) + 'A' + ' '.repeat(32); // columns 1-38
	const rowText = String(row).padStart(3, ' ');
	const colText = String(col).padStart(3, ' ');
	const escaped = text.replace(/'/g, "''");
	return `${prefix}${rowText}${colText}'${escaped}'`;
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
			? `Too long — max ${MAX_CONSTANT_TEXT_LENGTH} characters (longer needs DDS's line-continuation convention, not supported yet).`
			: undefined
	});
	if (!text) {return;} // Cancelled or left blank.

	const clampedRow = Math.min(Math.min(255, maxRow), Math.max(1, Math.round(row)));
	const clampedCol = Math.min(Math.min(255, maxCol), Math.max(1, Math.round(col)));
	const newLine = buildConstantLine(clampedRow, clampedCol, text);

	const anchorLineIndex = record.endIndex ?? record.lineIndex;
	const insertPosition = document.lineAt(anchorLineIndex).range.end;

	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, insertPosition, '\n' + newLine);

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage('PRTF: constant added.');
	} else {
		vscode.window.showErrorMessage('PRTF: could not add the constant — the document may be read-only.');
	};
};

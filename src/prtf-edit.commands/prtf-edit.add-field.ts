/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.add-field.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { resolveFlowModeInsertion } from '../prtf-edit.parser/prtf-edit.parser';

/** Field types offered by the quick-add flow — the v1 keyword scope (see README): character,
 * zoned decimal, date, time, timestamp. Floating point (F) and DBCS/UTF-16 (O/G) are left for a
 * hand-edit, same as the rest of the *AFPDS-only surface. */
const FIELD_TYPES: { label: string; value: string }[] = [
	{ label: 'A — Character', value: 'A' },
	{ label: 'S — Numeric (zoned decimal)', value: 'S' },
	{ label: 'L — Date', value: 'L' },
	{ label: 'T — Time', value: 'T' },
	{ label: 'Z — Timestamp', value: 'Z' }
];

/**
 * Builds a new field source line: blank indicator/reference zone, the name (left-justified in
 * columns 19-28), length/type/decimals, blank usage (O — output, the default), and Line/Position
 * (39-44). Length is left blank for L/T/Z — DDS derives it from DATFMT/TIMFMT (defaulting to
 * *ISO) rather than accepting one, same rule the parser already relies on (FIXED_LENGTH_BY_TYPE).
 *
 * `row` is `undefined` for a flow-mode target record (Line stays blank, matching the record's
 * existing SPACEB/SPACEA style — writing an explicit Line there would be a real CRTPRTF conflict);
 * in that case a `spaceBefore` count greater than 0 appends a keyword-only SPACEB(n) line right
 * after, positioning the new field relative to whatever printed immediately before it.
 * @param row - DDS line number (1-based), or undefined for a flow-mode record
 * @param spaceBefore - Lines to advance past the previous item via SPACEB — only used when row is undefined
 */
export function buildFieldLine(name: string, type: string, length: number, decimals: number, row: number | undefined, col: number, spaceBefore?: number): string[] {
	const nameField = name.toUpperCase().padEnd(10, ' ');
	const isDerivedLength = type === 'L' || type === 'T' || type === 'Z';
	const lengthField = isDerivedLength ? '     ' : String(length).padStart(5, ' ');
	const decimalsField = type === 'S' ? String(decimals).padStart(2, ' ') : '  ';
	const rowField = row !== undefined ? String(row).padStart(3, ' ') : '   ';
	const colField = String(col).padStart(3, ' ');

	const primaryLine = (
		' '.repeat(5) +   // 1-5 sequence
		'A' +             // 6 form type
		' ' +             // 7 comment
		' '.repeat(9) +   // 8-16 indicators
		' ' +             // 17 name type (blank = field, not record)
		' ' +             // 18 reserved
		nameField +       // 19-28 name
		' ' +             // 29 reference
		lengthField +     // 30-34 length
		type +            // 35 data type
		decimalsField +   // 36-37 decimal positions
		' ' +             // 38 usage (blank/O — output)
		rowField +        // 39-41 line
		colField          // 42-44 position
	);

	if (row === undefined && spaceBefore !== undefined && spaceBefore > 0) {
		// Keyword-only continuation line: blank name/position zone (columns 7-44), same shape as
		// any other multi-line DDS attribute in this codebase — linkAttributesToParents folds it
		// into this field's own attributes since nothing else names a field/record in between.
		const spaceBLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `SPACEB(${spaceBefore})`;
		return [primaryLine, spaceBLine];
	};

	return [primaryLine];
};

export const NAME_PATTERN = /^[A-Z@#$][A-Z0-9@#$]{0,9}$/;

/**
 * Adds a new field to a record at the given (row, col) — used by the preview's "+ Field" placing
 * mode. Chains a few prompts (name, type, size) rather than a custom form, same shape as
 * dspf-edit's own quick-add flow; then appends the new line right after the record's current last
 * line, same as add-constant.
 * @param recordName - Record to add the field to
 * @param row - DDS line number (1-based)
 * @param col - DDS position (1-based)
 * @param maxRow - Upper bound to clamp row to (the preview's configured page rows)
 * @param maxCol - Upper bound to clamp col to (the preview's configured page cols)
 */
export async function addFieldAt(recordName: string, row: number, col: number, maxRow: number, maxCol: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const record = ExtensionState.lastPrtfElements.find((e: any) => e.kind === 'record' && e.name === recordName) as { endIndex?: number; lineIndex: number } | undefined;
	if (!record) {return;}

	const existingNames = new Set(
		ExtensionState.lastPrtfElements
			.filter((e: any) => e.kind === 'field' && e.recordname === recordName)
			.map((e: any) => String(e.name).toUpperCase())
	);

	const rawName = await vscode.window.showInputBox({
		prompt: `New field at line ${row}, position ${col} — name`,
		placeHolder: 'FIELDNAME',
		validateInput: value => {
			const upper = value.trim().toUpperCase();
			if (!NAME_PATTERN.test(upper)) {return 'Must start with a letter (or @#$) and be 1-10 letters/digits/@#$.';}
			if (existingNames.has(upper)) {return `A field named ${upper} already exists in this record.`;}
			return undefined;
		}
	});
	if (!rawName) {return;}
	const name = rawName.trim().toUpperCase();

	const typeChoice = await vscode.window.showQuickPick(FIELD_TYPES, { placeHolder: 'Field type' });
	if (!typeChoice) {return;}
	const type = typeChoice.value;

	let length = 0;
	let decimals = 0;

	if (type === 'A') {
		const lengthText = await vscode.window.showInputBox({
			prompt: 'Field length',
			placeHolder: 'e.g. 10',
			validateInput: value => /^[1-9][0-9]*$/.test(value.trim()) && Number(value) <= 32767 ? undefined : 'Enter a whole number from 1 to 32767.'
		});
		if (!lengthText) {return;}
		length = Number(lengthText.trim());
	} else if (type === 'S') {
		const sizeText = await vscode.window.showInputBox({
			prompt: 'Field length, optionally with decimals',
			placeHolder: 'e.g. 7  or  11,2',
			validateInput: value => {
				const match = value.trim().match(/^([1-9][0-9]*)(?:,(\d+))?$/);
				if (!match) {return 'Enter a length, optionally followed by ,decimals (e.g. 11,2).';}
				const len = Number(match[1]);
				const dec = match[2] ? Number(match[2]) : 0;
				if (len > 63) {return 'Zoned decimal fields max out at 63 digits.';}
				if (dec > len) {return "Decimals can't exceed the total length.";}
				return undefined;
			}
		});
		if (!sizeText) {return;}
		const match = sizeText.trim().match(/^([1-9][0-9]*)(?:,(\d+))?$/)!;
		length = Number(match[1]);
		decimals = match[2] ? Number(match[2]) : 0;
	};
	// L/T/Z: no length prompt — see buildFieldLine.

	const clampedRow = Math.min(Math.min(255, maxRow), Math.max(1, Math.round(row)));
	const clampedCol = Math.min(Math.min(255, maxCol), Math.max(1, Math.round(col)));

	const flowInfo = resolveFlowModeInsertion(ExtensionState.lastPrtfElements, recordName);
	const newLines = flowInfo.isFlowMode
		? buildFieldLine(name, type, length, decimals, undefined, clampedCol, Math.max(0, clampedRow - (flowInfo.lastItemRow ?? 1)))
		: buildFieldLine(name, type, length, decimals, clampedRow, clampedCol);

	const anchorLineIndex = record.endIndex ?? record.lineIndex;
	const insertPosition = document.lineAt(anchorLineIndex).range.end;

	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, insertPosition, '\n' + newLines.join('\n'));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: field '${name}' added.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not add the field — the document may be read-only.');
	};
};

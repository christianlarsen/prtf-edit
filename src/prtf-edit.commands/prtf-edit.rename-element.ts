/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.rename-element.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfRecord, PrtfField } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { NAME_PATTERN, renameNameZone } from './prtf-edit.add-field';
import { existingRecordNames, promptForRecordName } from './prtf-edit.record-crud';

/** Renames a record format in place — its own name line's name zone (columns 19-28) is rewritten,
 * everything else (record-level keywords past column 44, its fields/constants) untouched. Not
 * offered for a field/constant's own name from here — see renameFieldFromNode. No cross-reference
 * fixup needed: nothing else in a PRTF source refers to a record format by name. */
export async function renameRecordFromNode(node: PrtfNode): Promise<void> {
	if (!node || node.source.kind !== 'record') {return;}
	const record = node.source as PrtfRecord;

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const otherNames = existingRecordNames();
	otherNames.delete(record.name.toUpperCase());
	const newName = await promptForRecordName(`New name for record '${record.name}'`, otherNames);
	if (!newName || newName === record.name.toUpperCase()) {return;} // Cancelled or unchanged.

	const line = document.lineAt(record.lineIndex);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, line.range, renameNameZone(line.text, newName));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: record renamed to '${newName}'.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not rename — the document may be read-only.');
	};
};

/** Renames a field in place — same idea as renameRecordFromNode, scoped to its own record instead
 * of the whole document. Not offered for a constant: a PrtfConstant's own `name` *is* its literal
 * text or system keyword (e.g. "'Total:'", "DATE"), not a separate identifier to rename. No
 * cross-reference fixup needed: REFFLD() only ever points at a field in an externally described
 * database file, never at another field defined in this same PRTF source. */
export async function renameFieldFromNode(node: PrtfNode): Promise<void> {
	if (!node || node.source.kind !== 'field') {return;}
	const field = node.source as PrtfField;

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const existingNames = new Set(
		ExtensionState.lastPrtfElements
			.filter((e: any) => e.kind === 'field' && e.recordname === field.recordname)
			.map((e: any) => String(e.name).toUpperCase())
	);
	existingNames.delete(field.name.toUpperCase());

	const rawName = await vscode.window.showInputBox({
		prompt: `New name for field '${field.name}' in '${field.recordname}'`,
		placeHolder: 'FIELDNAME',
		validateInput: value => {
			const upper = value.trim().toUpperCase();
			if (!NAME_PATTERN.test(upper)) {return 'Must start with a letter (or @#$) and be 1-10 letters/digits/@#$.';}
			if (existingNames.has(upper)) {return `A field named ${upper} already exists in '${field.recordname}'.`;}
			return undefined;
		}
	});
	if (!rawName) {return;} // Cancelled.
	const newName = rawName.trim().toUpperCase();
	if (newName === field.name.toUpperCase()) {return;} // Unchanged.

	const line = document.lineAt(field.lineIndex);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, line.range, renameNameZone(line.text, newName));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: field renamed to '${newName}'.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not rename — the document may be read-only.');
	};
};

export function registerRenameCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.rename-record', renameRecordFromNode),
		vscode.commands.registerCommand('prtf-edit.rename-field', renameFieldFromNode)
	);
};

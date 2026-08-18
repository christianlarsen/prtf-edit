/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.record-crud.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfRecord } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { NAME_PATTERN } from './prtf-edit.add-field';

/** A bare record-format line: form type 'A' (col 6), blank indicators (cols 7-16), name type 'R'
 * (col 17), blank reserved (col 18), name (cols 19-28) — see "Confirmed column layout" in the
 * README. No Line/Position/Length/Type/Usage zone: those don't apply to a record's own line. */
function buildRecordLine(name: string): string {
	return ' '.repeat(5) + 'A' + ' '.repeat(10) + 'R' + ' ' + name.padEnd(10);
};

/**
 * Rewrites just a record line's own name zone (columns 19-28), leaving everything else —
 * including any record-level keywords already coded past column 44 (HIGHLIGHT, SKIPB(n),
 * ENDPAGE, ...) — untouched. Same "surgical column rewrite" approach as move-element.ts's
 * buildRepositionedColumnOnly, used by copyRecordFromNode so a copy doesn't silently drop the
 * original's own record-level attributes.
 */
function renameRecordLine(originalLine: string, newName: string): string {
	const padded = originalLine.length < 28 ? originalLine.padEnd(28) : originalLine;
	return padded.substring(0, 18) + newName.padEnd(10) + padded.substring(28);
};

function existingRecordNames(): Set<string> {
	return new Set(
		ExtensionState.lastPrtfElements
			.filter((e: any) => e.kind === 'record')
			.map((e: any) => String(e.name).toUpperCase())
	);
};

/** Shared validated-name prompt for both addRecord and copyRecordFromNode — same DDS identifier
 * rules as a field name (add-field.ts's NAME_PATTERN), but uniqueness is checked document-wide
 * (record format names, unlike field names, aren't scoped to one record). */
async function promptForRecordName(promptText: string, existingNames: Set<string>): Promise<string | undefined> {
	const input = await vscode.window.showInputBox({
		prompt: promptText,
		placeHolder: 'RECORDNAME',
		validateInput: value => {
			const upper = value.trim().toUpperCase();
			if (!NAME_PATTERN.test(upper)) {return 'Must start with a letter (or @#$) and be 1-10 letters/digits/@#$.';}
			if (existingNames.has(upper)) {return `A record named ${upper} already exists in this file.`;}
			return undefined;
		}
	});
	return input?.trim().toUpperCase();
};

/** Appends a new, empty record format at the end of the document — used by the "Definition"
 * view's title-bar "+" button, and by a record's own context menu (available at both levels,
 * mirroring dspf-edit). */
export async function addRecord(): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const name = await promptForRecordName('New record format name', existingRecordNames());
	if (!name) {return;} // Cancelled or left blank.

	const insertPosition = document.lineAt(document.lineCount - 1).range.end;
	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, insertPosition, '\n' + buildRecordLine(name));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: record '${name}' added.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not add the record — the document may be read-only.');
	};
};

/** Deletes a record format entirely — its own name line through the last line of its last field/
 * constant/attribute (PrtfRecord.endIndex, already resolved by the parser to exactly that range).
 * Confirms first: unlike deleting a single field/constant, this can take a whole set of them with
 * it, so it's treated as the bigger, less obviously reversible action it is. */
export async function deleteRecordFromNode(node: PrtfNode): Promise<void> {
	if (!node || node.source.kind !== 'record') {return;}
	const record = node.source as PrtfRecord;

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const itemCount = ExtensionState.lastPrtfElements.filter((e: any) =>
		(e.kind === 'field' || e.kind === 'constant') && e.recordname === record.name).length;

	const choice = await vscode.window.showWarningMessage(
		`Delete record '${record.name}'${itemCount > 0 ? ` and its ${itemCount} field(s)/constant(s)` : ''}? This can't be undone from within the extension.`,
		{ modal: true },
		'Delete'
	);
	if (choice !== 'Delete') {return;} // Cancelled.

	const endIndex = record.endIndex ?? record.lineIndex;
	const startLine = document.lineAt(record.lineIndex);
	const endLine = document.lineAt(endIndex);

	const edit = new vscode.WorkspaceEdit();
	edit.delete(document.uri, new vscode.Range(startLine.range.start, endLine.rangeIncludingLineBreak.end));

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not delete the record — the document may be read-only.');
	};
};

/** Duplicates a record format's entire block (name line through PrtfRecord.endIndex) under a new
 * name, appended at the end of the document — same insertion point as addRecord. Only the name
 * zone of the first line is rewritten (renameRecordLine); every field, constant, and keyword —
 * including the original's own record-level attributes, if any — is copied verbatim. */
export async function copyRecordFromNode(node: PrtfNode): Promise<void> {
	if (!node || node.source.kind !== 'record') {return;}
	const record = node.source as PrtfRecord;

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const newName = await promptForRecordName(`New name for the copy of '${record.name}'`, existingRecordNames());
	if (!newName) {return;} // Cancelled or left blank.

	const endIndex = record.endIndex ?? record.lineIndex;
	const blockLines: string[] = [];
	for (let i = record.lineIndex; i <= endIndex; i++) {
		blockLines.push(document.lineAt(i).text);
	};
	blockLines[0] = renameRecordLine(blockLines[0], newName);

	const insertPosition = document.lineAt(document.lineCount - 1).range.end;
	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, insertPosition, '\n' + blockLines.join('\n'));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: record copied as '${newName}'.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not copy the record — the document may be read-only.');
	};
};

export function registerRecordCrudCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.add-record', addRecord),
		vscode.commands.registerCommand('prtf-edit.delete-record', deleteRecordFromNode),
		vscode.commands.registerCommand('prtf-edit.copy-record', copyRecordFromNode)
	);
};

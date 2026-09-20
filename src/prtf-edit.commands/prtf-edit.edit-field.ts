/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-field.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfField } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { FIELD_TYPES, NAME_PATTERN, rewriteFieldLine } from './prtf-edit.add-field';
import { CHRID_PATTERN, EDTCDE_PATTERN } from './prtf-edit.edit-attributes';

const MAX_CHAR_LENGTH = 32767;
const MAX_NUMERIC_LENGTH = 63;

/** Lengths DDS fixes for the date/time/timestamp types — used as the starting point when a field
 * becomes one of them's opposite (character/numeric), since it had no length of its own to keep. */
const DEFAULT_LENGTH_BY_TYPE: Record<string, number> = { L: 10, T: 8, Z: 26 };

type FieldDraft = { name: string; type: string; length: number; decimals: number };

const isDerivedLengthType = (type: string) => type === 'L' || type === 'T' || type === 'Z';
const hasEditableSize = (type: string) => type === 'A' || type === 'S';

/** Text of the "Size" row and of its input box: "10" for a character field, "11,2" for a numeric one. */
function formatSize(draft: FieldDraft): string {
	return draft.type === 'S' ? `${draft.length},${draft.decimals}` : String(draft.length);
};

/** Parses what was typed into the size box for `type`, or returns why it isn't valid — the same
 * limits "+ Field" enforces (1-32767 characters; 1-63 digits with decimals no larger than the length). */
function parseSize(type: string, text: string): { length: number; decimals: number } | string {
	const trimmed = text.trim();
	if (type === 'A') {
		return /^[1-9][0-9]*$/.test(trimmed) && Number(trimmed) <= MAX_CHAR_LENGTH
			? { length: Number(trimmed), decimals: 0 }
			: `Enter a whole number from 1 to ${MAX_CHAR_LENGTH}.`;
	};
	const match = trimmed.match(/^([1-9][0-9]*)(?:,(\d+))?$/);
	if (!match) {return 'Enter a length, optionally followed by ,decimals (e.g. 11,2).';}
	const length = Number(match[1]);
	const decimals = match[2] ? Number(match[2]) : 0;
	if (length > MAX_NUMERIC_LENGTH) {return `Zoned decimal fields max out at ${MAX_NUMERIC_LENGTH} digits.`;}
	if (decimals > length) {return "Decimals can't exceed the total length.";}
	return { length, decimals };
};

/** Moves the draft to `newType`, adjusting its size to something the new type accepts: decimals
 * only exist on numeric, date/time/timestamp have no length of their own, and going the other way
 * starts from the length DDS would have fixed for that type. Returns notes on what was dropped or clamped. */
function changeType(draft: FieldDraft, newType: string): string[] {
	const notes: string[] = [];
	const oldType = draft.type;
	if (newType === oldType) {return notes;}

	if (isDerivedLengthType(oldType) && hasEditableSize(newType)) {
		draft.length = DEFAULT_LENGTH_BY_TYPE[oldType];
		draft.decimals = 0;
		notes.push(`length starts at ${draft.length} — adjust it if needed`);
	};
	if (oldType === 'S' && newType !== 'S' && draft.decimals > 0) {
		notes.push(`decimals (${draft.decimals}) removed`);
		draft.decimals = 0;
	};
	if (newType === 'S' && draft.length > MAX_NUMERIC_LENGTH) {
		notes.push(`length reduced from ${draft.length} to ${MAX_NUMERIC_LENGTH} (numeric maximum)`);
		draft.length = MAX_NUMERIC_LENGTH;
	};
	if (isDerivedLengthType(newType)) {
		notes.push('length is derived from the date/time format');
		draft.length = 0;
		draft.decimals = 0;
	};
	if (newType === 'S') {draft.decimals = Math.min(draft.decimals, draft.length);}
	draft.type = newType;
	return notes;
};

type MenuAction = 'name' | 'type' | 'size' | 'apply';

/**
 * Edits a field's own name, type and size through a small menu: one row per property showing its
 * current value (pick it to change just that one), then "Apply" to write everything at once. Type
 * and size are kept consistent as they change (see changeType) — a numeric field losing its
 * decimals when it becomes character, a date/time/timestamp having no size, and so on.
 *
 * A referenced field (R in column 29) borrows its type/length/decimals from REFFLD(), so only its
 * name is offered here. Rewrites just the field's own zones (see rewriteFieldLine); Line/Position,
 * keywords and indicators are untouched — though a size change can shift whatever is positioned
 * relative to this field with a "+n" Position, same caveat as editing a constant's text.
 * @param lineIndex - Zero-based source line of the field to edit
 */
export async function editField(lineIndex: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const field = ExtensionState.lastPrtfElements.find((e: any) => e.kind === 'field' && e.lineIndex === lineIndex) as PrtfField | undefined;
	if (!field) {return;}

	const original: FieldDraft = { name: field.name.toUpperCase(), type: field.type ?? 'A', length: field.length ?? 0, decimals: field.decimals ?? 0 };
	const draft: FieldDraft = { ...original };
	const referenced = Boolean(field.referenced);
	let notes: string[] = [];

	const otherNames = new Set(
		ExtensionState.lastPrtfElements
			.filter((e: any) => e.kind === 'field' && e.recordname === field.recordname && e.lineIndex !== field.lineIndex)
			.map((e: any) => String(e.name).toUpperCase())
	);
	// A type this menu doesn't otherwise offer (e.g. floating point) still has to be listed, or a
	// name-only edit would have no way to keep it.
	const typeChoices = FIELD_TYPES.some(t => t.value === original.type)
		? FIELD_TYPES
		: [{ label: `${original.type} — (current type)`, value: original.type }, ...FIELD_TYPES];
	const typeLabel = (type: string) => typeChoices.find(t => t.value === type)?.label ?? type;

	while (true) {
		const changed = draft.name !== original.name || draft.type !== original.type || draft.length !== original.length || draft.decimals !== original.decimals;
		type Row = vscode.QuickPickItem & { action?: MenuAction };
		const rows: Row[] = [
			{ label: '$(edit) Name', description: draft.name, action: 'name' }
		];
		if (!referenced) {
			rows.push({ label: '$(symbol-misc) Type', description: typeLabel(draft.type), action: 'type' });
			if (hasEditableSize(draft.type)) {
				rows.push({ label: '$(arrow-both) Size', description: formatSize(draft), detail: draft.type === 'S' ? 'length,decimals' : 'length', action: 'size' });
			} else if (isDerivedLengthType(draft.type)) {
				rows.push({ label: '$(arrow-both) Size', description: '(derived from the date/time format)' });
			};
		};
		if (changed) {
			rows.push(
				{ label: '', kind: vscode.QuickPickItemKind.Separator },
				{ label: '$(check) Apply changes', detail: notes.length > 0 ? notes.join(' · ') : undefined, action: 'apply' }
			);
		};

		const picked = await vscode.window.showQuickPick(rows, {
			placeHolder: referenced
				? `Field '${field.name}' — type/size come from REFFLD, only the name can be changed here`
				: `Field '${field.name}' — pick a row to change it${changed ? ', then Apply' : ''} (Esc to cancel)`
		});
		if (!picked?.action) {
			if (picked) {continue;} // A read-only row.
			return; // Cancelled.
		};

		if (picked.action === 'name') {
			const input = await vscode.window.showInputBox({
				prompt: `Field name in '${field.recordname}'`,
				value: draft.name,
				validateInput: value => {
					const upper = value.trim().toUpperCase();
					if (!NAME_PATTERN.test(upper)) {return 'Must start with a letter (or @#$) and be 1-10 letters/digits/@#$.';}
					if (otherNames.has(upper)) {return `A field named ${upper} already exists in '${field.recordname}'.`;}
					return undefined;
				}
			});
			if (input !== undefined) {draft.name = input.trim().toUpperCase();}

		} else if (picked.action === 'type') {
			const typePicked = await vscode.window.showQuickPick(
				typeChoices.map(t => ({ label: t.label, description: t.value === draft.type ? 'current' : undefined, value: t.value })),
				{ placeHolder: 'Field type' }
			);
			if (typePicked) {
				const newNotes = changeType(draft, typePicked.value);
				notes = typePicked.value === original.type ? [] : newNotes;
				if (typePicked.value === original.type) {
					// Back to where it started: restore the original size too, not whatever it was adjusted to.
					draft.length = original.length;
					draft.decimals = original.decimals;
				};
			};

		} else if (picked.action === 'size') {
			const input = await vscode.window.showInputBox({
				prompt: draft.type === 'S' ? 'Length, optionally with decimals' : 'Length',
				value: formatSize(draft),
				placeHolder: draft.type === 'S' ? 'e.g. 7  or  11,2' : 'e.g. 10',
				validateInput: value => {
					const result = parseSize(draft.type, value);
					return typeof result === 'string' ? result : undefined;
				}
			});
			if (input !== undefined) {
				const size = parseSize(draft.type, input);
				if (typeof size !== 'string') {
					draft.length = size.length;
					draft.decimals = size.decimals;
				};
			};

		} else {
			break;
		};
	};

	const line = document.lineAt(field.lineIndex);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, line.range, rewriteFieldLine(line.text, draft.name, draft.type, draft.length, draft.decimals));
	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not update the field — the document may be read-only.');
		return;
	};
	vscode.window.showInformationMessage(`PRTF: field '${draft.name}' updated.`);

	// Keywords that only make sense on some types aren't touched here (they can sit on any line of
	// the field's block) — so say so, rather than leave an invalid combination unmentioned.
	const isNumeric = draft.type === 'S' || draft.type === 'F';
	const keywordLeft = (pattern: RegExp) => (field.attributes ?? []).some(attr => pattern.test(attr.value));
	if (!isNumeric && draft.type !== original.type && keywordLeft(EDTCDE_PATTERN)) {
		vscode.window.showWarningMessage(`PRTF: '${draft.name}' is no longer numeric but still has EDTCDE — remove it with "Edit Attributes".`);
	};
	if (isNumeric && draft.type !== original.type && keywordLeft(CHRID_PATTERN)) {
		vscode.window.showWarningMessage(`PRTF: '${draft.name}' is now numeric but still has CHRID, which isn't valid on numeric fields — remove it with "Edit Attributes".`);
	};
};

/** Adapter for the Definition tree's context-menu entry (restricted to field nodes via viewItem). */
export function editFieldFromNode(node: PrtfNode): void {
	if (!node || node.source.kind !== 'field') {return;}
	void editField(node.source.lineIndex);
};

export function registerEditFieldCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.edit-field', editFieldFromNode)
	);
};

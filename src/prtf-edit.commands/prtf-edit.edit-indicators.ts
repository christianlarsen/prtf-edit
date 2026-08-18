/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-indicators.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfField, PrtfConstant, PrtfAttribute, PrtfIndicator, groupIndicatorsByCondition } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';

/** DDS's own limit: up to 3 continuation lines' worth of 3-per-line slots = 9 ANDed indicators
 * per group (see "Confirmed column layout" — 9-char indicator zone, 3 slots of 3 chars). */
const MAX_PER_GROUP = 9;

type IndicatorItem = PrtfField | PrtfConstant | PrtfAttribute;

function itemLabel(item: IndicatorItem): string {
	if ('name' in item && item.name) {return item.name;};
	if ('value' in item && item.value) {return item.value;};
	return `line ${item.lineIndex + 1}`;
};

function summarizeGroups(groups: PrtfIndicator[][]): string {
	return groups.map(g => g.map(ind => `${ind.active ? '' : 'NOT '}${ind.number}`).join(' AND ')).join('  OR  ');
};

/** One physical line's worth of indicator zone: up to 3 indicators, tagged with the column-7
 * marker it needs (' ' continues the current AND group, 'O' starts a new OR'd one). */
interface Chunk {
	marker: ' ' | 'O';
	indicators: PrtfIndicator[];
};

/** Inverse of the parser's own accumulation (resolveLineIndicators/accumulatePendingIndicators):
 * splits each AND-group into ≤3-indicator chunks (DDS's own 3-slots-per-line limit), marking only
 * a group's *first* chunk 'O' when it isn't the very first group overall — matching exactly what
 * the parser expects to read back the same groups.
 */
function chunkGroups(groups: PrtfIndicator[][]): Chunk[] {
	const chunks: Chunk[] = [];
	groups.forEach((group, groupIndex) => {
		for (let i = 0; i < group.length; i += 3) {
			chunks.push({
				marker: (i === 0 && groupIndex > 0) ? 'O' : ' ',
				indicators: group.slice(i, i + 3)
			});
		};
	});
	return chunks;
};

/** Builds a 9-char indicator zone (columns 8-16) from up to 3 indicators — mirrors
 * parseDdsIndicators' own 3-slots-of-3-chars reading in reverse. */
function buildIndicatorZone(indicators: PrtfIndicator[]): string {
	const segments = indicators.map(ind => (ind.active ? ' ' : 'N') + String(ind.number).padStart(2, '0'));
	return segments.join('').padEnd(9);
};

/**
 * Rewrites an item's indicator conditioning to `newGroups`. Unlike every other continuation
 * convention in this codebase, indicator continuation lines *precede* the line they condition
 * (see prtf-edit.model.ts's indicatorLineIndices doc comment) — so this deletes the item's
 * existing continuation lines individually (they aren't guaranteed contiguous: a comment line can
 * legally sit between two of them without breaking the parser's own accumulation), then replaces
 * the item's own primary line with however many new continuation lines are needed, prepended,
 * followed by the primary line itself rewritten with just the *last* chunk. Folding the
 * continuation-line insertion and the primary-line rewrite into one `edit.replace` (rather than a
 * separate insert + replace touching the same position) avoids any ambiguity about adjacent edits
 * in the same WorkspaceEdit.
 */
function applyIndicatorGroups(document: vscode.TextDocument, edit: vscode.WorkspaceEdit, item: IndicatorItem, newGroups: PrtfIndicator[][]): void {
	const existingContinuationLines = (item.indicatorLineIndices ?? []).slice(0, -1);
	for (const lineIdx of existingContinuationLines) {
		edit.delete(document.uri, document.lineAt(lineIdx).rangeIncludingLineBreak);
	};

	const chunks = chunkGroups(newGroups.filter(g => g.length > 0));
	const primaryLine = document.lineAt(item.lineIndex);
	const padded = primaryLine.text.length < 16 ? primaryLine.text.padEnd(16) : primaryLine.text;

	const lastChunk = chunks[chunks.length - 1];
	const newZone = lastChunk ? (lastChunk.marker + buildIndicatorZone(lastChunk.indicators)) : ' ' + ' '.repeat(9);
	const updatedPrimaryText = padded.substring(0, 6) + newZone + padded.substring(16);

	const precedingChunks = chunks.slice(0, -1);
	const prefix = precedingChunks.length > 0
		? precedingChunks.map(chunk => '     A' + chunk.marker + buildIndicatorZone(chunk.indicators)).join('\n') + '\n'
		: '';

	edit.replace(document.uri, primaryLine.range, prefix + updatedPrimaryText);
};

async function promptAddIndicator(groups: PrtfIndicator[][]): Promise<PrtfIndicator[][] | undefined> {
	let targetGroupIndex: number;

	if (groups.length === 0) {
		targetGroupIndex = 0;
	} else {
		const groupChoices = groups.map((g, i) => ({
			label: `Group ${i + 1} (AND)`,
			description: g.map(ind => `${ind.active ? '' : 'NOT '}${ind.number}`).join(' AND '),
			index: i
		})).concat([{ label: "+ New OR'd group", description: '', index: groups.length }]);
		const groupPicked = await vscode.window.showQuickPick(groupChoices, { placeHolder: 'Add to which AND-group?' });
		if (!groupPicked) {return undefined;} // Cancelled.
		targetGroupIndex = groupPicked.index;
	};

	if (targetGroupIndex < groups.length && groups[targetGroupIndex].length >= MAX_PER_GROUP) {
		vscode.window.showErrorMessage(`PRTF: Group ${targetGroupIndex + 1} already has the DDS maximum of ${MAX_PER_GROUP} ANDed indicators.`);
		return undefined;
	};

	const numberInput = await vscode.window.showInputBox({
		prompt: 'Indicator number (1-99)',
		placeHolder: '51',
		validateInput: value => {
			const trimmed = value.trim();
			return /^[1-9][0-9]?$/.test(trimmed) && Number(trimmed) <= 99 ? undefined : 'Enter a whole number from 1 to 99.';
		}
	});
	if (numberInput === undefined) {return undefined;} // Cancelled.
	const number = Number(numberInput.trim());

	const activePicked = await vscode.window.showQuickPick(
		[
			{ label: 'ON', description: `active when *IN${String(number).padStart(2, '0')} is on`, active: true },
			{ label: 'OFF (NOT)', description: `active when *IN${String(number).padStart(2, '0')} is off`, active: false }
		],
		{ placeHolder: 'Condition' }
	);
	if (!activePicked) {return undefined;} // Cancelled.

	const newGroups = groups.map(g => [...g]);
	if (targetGroupIndex >= newGroups.length) {newGroups.push([]);};
	newGroups[targetGroupIndex].push({ active: activePicked.active, number });
	return newGroups;
};

async function promptRemoveIndicator(groups: PrtfIndicator[][]): Promise<PrtfIndicator[][] | undefined> {
	const choices = groups.flatMap((group, groupIndex) =>
		group.map((ind, indexInGroup) => ({
			label: `${ind.active ? '' : 'NOT '}${ind.number}`,
			description: `Group ${groupIndex + 1}${groupIndex > 0 ? ' (OR)' : ''}`,
			groupIndex,
			indexInGroup
		}))
	);
	const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Remove which indicator?' });
	if (!picked) {return undefined;} // Cancelled.

	const newGroups = groups.map(g => [...g]);
	newGroups[picked.groupIndex].splice(picked.indexInGroup, 1);
	return newGroups.filter(g => g.length > 0); // Drop an emptied group — the rest renumber naturally.
};

async function promptRemoveGroup(groups: PrtfIndicator[][]): Promise<PrtfIndicator[][] | undefined> {
	const choices = groups.map((g, i) => ({
		label: `Group ${i + 1}`,
		description: g.map(ind => `${ind.active ? '' : 'NOT '}${ind.number}`).join(' AND '),
		index: i
	}));
	const picked = await vscode.window.showQuickPick(choices, { placeHolder: "Remove which OR'd group?" });
	if (!picked) {return undefined;} // Cancelled.
	return groups.filter((_, i) => i !== picked.index);
};

/**
 * Lets the user add, remove, or clear the DDS indicator conditioning (AND groups, OR'd
 * alternatives) on a field, constant, or a specific keyword (attribute line) — one change per
 * invocation, same convention as edit-spacing.ts/edit-attributes.ts.
 */
export async function editIndicators(item: IndicatorItem): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const groups = groupIndicatorsByCondition(item.indicators);
	const label = itemLabel(item);
	const summary = groups.length > 0 ? summarizeGroups(groups) : '(none)';

	const actions: { label: string; action: 'add' | 'removeIndicator' | 'removeGroup' | 'clear' }[] = [
		{ label: '+ Add indicator...', action: 'add' }
	];
	if (groups.length > 0) {actions.push({ label: 'Remove indicator...', action: 'removeIndicator' });};
	if (groups.length > 1) {actions.push({ label: "Remove OR'd group...", action: 'removeGroup' });};
	if (groups.length > 0) {actions.push({ label: 'Clear all indicators', action: 'clear' });};

	const picked = await vscode.window.showQuickPick(actions, { placeHolder: `Indicators on '${label}': ${summary}` });
	if (!picked) {return;} // Cancelled.

	let newGroups: PrtfIndicator[][] | undefined;

	if (picked.action === 'add') {
		newGroups = await promptAddIndicator(groups);
	} else if (picked.action === 'removeIndicator') {
		newGroups = await promptRemoveIndicator(groups);
	} else if (picked.action === 'removeGroup') {
		newGroups = await promptRemoveGroup(groups);
	} else {
		const choice = await vscode.window.showWarningMessage(`Clear all indicators on '${label}'?`, { modal: true }, 'Clear');
		if (choice !== 'Clear') {return;} // Cancelled.
		newGroups = [];
	};

	if (newGroups === undefined) {return;} // Cancelled somewhere in the sub-flow.

	const edit = new vscode.WorkspaceEdit();
	applyIndicatorGroups(document, edit, item, newGroups);

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the indicator change — the document may be read-only.');
	};
};

/** Adapter for the "Definition" tree's context-menu entry — accepts a field, constant, or
 * attribute (keyword) node, mirroring editAttributesFromNode. */
export function editIndicatorsFromNode(node: PrtfNode): void {
	if (!node) {return;}
	if (node.source.kind !== 'field' && node.source.kind !== 'constant' && node.source.kind !== 'attribute') {return;}
	void editIndicators(node.source);
};

export function registerEditIndicatorsCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.edit-indicators', editIndicatorsFromNode)
	);
};

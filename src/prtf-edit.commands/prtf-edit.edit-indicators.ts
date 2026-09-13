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

/** DDS's own limit on OR'd conditions for a single field/constant/keyword (each itself an
 * AND-group of up to MAX_PER_GROUP indicators). */
const MAX_OR_GROUPS = 9;

type IndicatorItem = PrtfField | PrtfConstant | PrtfAttribute;

function itemLabel(item: IndicatorItem): string {
	if ('name' in item && item.name) {return item.name;};
	if ('value' in item && item.value) {return item.value;};
	return `line ${item.lineIndex + 1}`;
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

function formatIndicator(ind: PrtfIndicator): string {
	return `${ind.active ? '' : 'N'}${String(ind.number).padStart(2, '0')}`;
};

function formatGroupSummary(group: PrtfIndicator[]): string {
	return group.map(formatIndicator).join(', ');
};

/** Parses one typed-in indicator, e.g. "51" (ON) or "N51" (OFF) — the single format used
 * throughout this flow, whether adding a fresh group or changing one indicator in place. */
function parseIndicatorInput(value: string): PrtfIndicator | undefined {
	const match = /^(N?)([0-9]{1,2})$/i.exec(value.trim());
	if (!match) {return undefined;};
	const number = Number(match[2]);
	if (number < 1 || number > 99) {return undefined;};
	return { active: match[1].toUpperCase() !== 'N', number };
};

/**
 * Collects one new AND-group of indicators via repeated input boxes — leaving one blank finishes
 * the group, Esc cancels the whole thing. `existing` seeds an in-progress group (used when adding
 * more indicators to one that already has some) so duplicates against it are caught too.
 */
async function collectIndicatorGroup(maxCount: number, existing: PrtfIndicator[] = []): Promise<PrtfIndicator[] | undefined> {
	const collected = [...existing];
	while (collected.length < maxCount) {
		const input = await vscode.window.showInputBox({
			title: `Indicator ${collected.length + 1}/${maxCount} (leave empty to finish)`,
			prompt: "e.g. '51' (ON) or 'N51' (OFF)",
			placeHolder: '51',
			validateInput: value => {
				if (!value.trim()) {return undefined;}; // Empty finishes the group.
				const parsed = parseIndicatorInput(value);
				if (!parsed) {return "Enter a whole number 1-99, optionally prefixed with 'N' (e.g. '51', 'N51').";};
				if (collected.some(ind => ind.number === parsed.number && ind.active === parsed.active)) {return 'This indicator is already in the group.';};
				return undefined;
			}
		});
		if (input === undefined) {return undefined;}; // Cancelled.
		if (!input.trim()) {break;}; // Finished.
		collected.push(parseIndicatorInput(input)!);
	};
	return collected;
};

/** One row of the indicators menu: an existing OR'd AND-group (`groupIndex` into `groups`), or one
 * of the two trailing action rows. */
interface IndicatorMenuItem extends vscode.QuickPickItem {
	groupIndex: number;
	action?: 'addOr' | 'removeAll';
};

const EDIT_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Modify' };
const REMOVE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };

/**
 * Builds the indicators menu's rows: one per existing OR'd AND-group (e.g. "51, N61, 53", with
 * edit + trash buttons), plus an "Add OR condition..." row, plus a "Remove all" row when there's
 * more than one group (with just one, its own trash button already does the same thing).
 */
function buildIndicatorMenuItems(groups: PrtfIndicator[][]): IndicatorMenuItem[] {
	const items: IndicatorMenuItem[] = groups.map((group, index) => ({
		groupIndex: index,
		label: groups.length > 1 ? `Condition ${index + 1}: ${formatGroupSummary(group)}` : formatGroupSummary(group),
		buttons: [EDIT_BUTTON, REMOVE_BUTTON]
	}));

	items.push({ groupIndex: -1, action: 'addOr', label: '$(add) Add OR condition...' });

	if (groups.length > 1) {
		items.push({ groupIndex: -1, action: 'removeAll', label: '$(trash) Remove all indicators' });
	};

	return items;
};

/**
 * Shows the indicators menu and resolves to what the user did: picked a row (or its edit button)
 * to modify that OR'd condition (`action: 'edit'`), clicked a row's trash button to remove just
 * that one (`action: 'remove'`), or picked one of the trailing action rows
 * (`'addOr'`/`'removeAll'`) — undefined if dismissed. Needs the raw `createQuickPick` API rather
 * than `showQuickPick`, since only it exposes per-item buttons (`onDidTriggerItemButton`).
 */
function showIndicatorMenu(
	items: IndicatorMenuItem[],
	label: string
): Promise<{ action: 'edit' | 'remove' | 'addOr' | 'removeAll'; groupIndex: number } | undefined> {
	return new Promise(resolve => {
		const quickPick = vscode.window.createQuickPick<IndicatorMenuItem>();
		quickPick.items = items;
		quickPick.title = `Indicators for '${label}'`;
		quickPick.placeholder = 'Select a condition to modify, use its buttons, or add an OR condition';
		quickPick.ignoreFocusOut = true;

		let settled = false;
		const finish = (result: { action: 'edit' | 'remove' | 'addOr' | 'removeAll'; groupIndex: number } | undefined) => {
			if (settled) {return;};
			settled = true;
			resolve(result);
			quickPick.hide();
		};

		quickPick.onDidTriggerItemButton(event => {
			finish({ action: event.button === REMOVE_BUTTON ? 'remove' : 'edit', groupIndex: event.item.groupIndex });
		});
		quickPick.onDidAccept(() => {
			const picked = quickPick.selectedItems[0];
			if (!picked) {finish(undefined); return;};
			finish({ action: picked.action ?? 'edit', groupIndex: picked.groupIndex });
		});
		quickPick.onDidHide(() => {
			finish(undefined);
			quickPick.dispose();
		});

		quickPick.show();
	});
};

/**
 * Drills into one existing OR'd condition: add another indicator to it, change or remove one of
 * its indicators, or clear it and start over. Emptying the group this way removes the whole OR
 * condition, rather than leaving a dangling AND-group with nothing in it.
 */
async function modifyGroup(groups: PrtfIndicator[][], groupIndex: number): Promise<PrtfIndicator[][] | undefined> {
	const current = groups[groupIndex];
	const indicatorChoices = current.map((ind, i) => `Position ${i + 1}: ${formatIndicator(ind)}`);

	const picked = await vscode.window.showQuickPick(
		[...indicatorChoices, '+ Add new indicator', 'Clear all and start over'],
		{ title: 'Modify condition', placeHolder: 'Choose an indicator to modify, or an action' }
	);
	if (!picked) {return undefined;}; // Cancelled, no change.

	const replaceGroup = (newGroup: PrtfIndicator[]): PrtfIndicator[][] =>
		newGroup.length > 0
			? groups.map((g, i) => i === groupIndex ? newGroup : g)
			: groups.filter((_, i) => i !== groupIndex);

	if (picked === 'Clear all and start over') {
		const newGroup = await collectIndicatorGroup(MAX_PER_GROUP);
		return newGroup === undefined ? undefined : replaceGroup(newGroup);
	};

	if (picked === '+ Add new indicator') {
		if (current.length >= MAX_PER_GROUP) {
			vscode.window.showWarningMessage(`PRTF: this condition already has the DDS maximum of ${MAX_PER_GROUP} ANDed indicators.`);
			return undefined;
		};
		const newGroup = await collectIndicatorGroup(MAX_PER_GROUP, current);
		return newGroup === undefined ? undefined : replaceGroup(newGroup);
	};

	// One specific indicator picked, by its position in the list above.
	const index = indicatorChoices.indexOf(picked);
	const action = await vscode.window.showQuickPick(
		['Change value', 'Remove this indicator'],
		{ title: `Modify ${formatIndicator(current[index])}`, placeHolder: 'Choose action' }
	);
	if (!action) {return undefined;}; // Cancelled.

	if (action === 'Remove this indicator') {
		return replaceGroup(current.filter((_, i) => i !== index));
	};

	const input = await vscode.window.showInputBox({
		title: `New value for position ${index + 1}`,
		prompt: "e.g. '51' (ON) or 'N51' (OFF)",
		value: formatIndicator(current[index]),
		validateInput: value => {
			const parsed = parseIndicatorInput(value);
			if (!parsed) {return "Enter a whole number 1-99, optionally prefixed with 'N' (e.g. '51', 'N51').";};
			if (current.some((ind, i) => i !== index && ind.number === parsed.number && ind.active === parsed.active)) {return 'This indicator is already used in another position.';};
			return undefined;
		}
	});
	if (input === undefined) {return undefined;}; // Cancelled.

	const updated = [...current];
	updated[index] = parseIndicatorInput(input)!;
	return replaceGroup(updated);
};

/**
 * Lets the user add, remove, or clear the DDS indicator conditioning (AND groups, OR'd
 * alternatives) on a field, constant, or a specific keyword (attribute line). The menu shows each
 * existing OR'd condition as its own row — with edit/trash buttons right on it — rather than
 * asking "what do you want to do?" first.
 */
export async function editIndicators(item: IndicatorItem): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const groups = groupIndicatorsByCondition(item.indicators);
	const label = itemLabel(item);

	let newGroups: PrtfIndicator[][] | undefined;

	if (groups.length === 0) {
		// No condition yet: collect a single fresh AND-group directly, no menu needed.
		const firstGroup = await collectIndicatorGroup(MAX_PER_GROUP);
		if (!firstGroup || firstGroup.length === 0) {return;}; // Cancelled, or nothing entered.
		newGroups = [firstGroup];
	} else {
		const choice = await showIndicatorMenu(buildIndicatorMenuItems(groups), label);
		if (!choice) {return;}; // Cancelled.

		if (choice.action === 'removeAll') {
			newGroups = [];
		} else if (choice.action === 'remove') {
			newGroups = groups.filter((_, i) => i !== choice.groupIndex);
		} else if (choice.action === 'addOr') {
			if (groups.length >= MAX_OR_GROUPS) {
				vscode.window.showWarningMessage(`PRTF: maximum of ${MAX_OR_GROUPS} OR'd conditions reached (DDS limit).`);
				return;
			};
			const newGroup = await collectIndicatorGroup(MAX_PER_GROUP);
			if (!newGroup || newGroup.length === 0) {return;}; // Cancelled, or nothing entered.
			newGroups = [...groups, newGroup];
		} else {
			newGroups = await modifyGroup(groups, choice.groupIndex);
			if (newGroups === undefined) {return;}; // Cancelled.
		};
	};

	if (newGroups === undefined) {return;}; // Cancelled somewhere in the sub-flow.

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

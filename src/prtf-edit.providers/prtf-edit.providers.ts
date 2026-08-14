/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.providers.ts
*/

import * as vscode from 'vscode';
import {
	PrtfElement,
	PrtfRecord,
	PrtfField,
	PrtfConstant,
	PrtfAttribute,
	PrtfIndicator,
	groupIndicatorsByCondition
} from '../prtf-edit.model/prtf-edit.model';
import { ExtensionState } from '../prtf-edit.states/state';

/** What a synthetic (non-parsed) group node organizes — carries enough context (which record,
 * which field/constant by line) for getParent() to reconstruct the chain up to the root without
 * needing a live tree-walk, which VS Code's TreeView.reveal() requires. */
type GroupRole = 'file' | 'records' | 'recordAttrs' | 'recordFields' | 'itemIndicators' | 'itemAttrs' | 'leafGroup';

interface GroupNode {
	kind: 'treeGroup';
	role: GroupRole;
	id: string;
	label: string;
	recordName?: string;
	itemLineIndex?: number;
	children: PrtfNodeSource[];
};

type PrtfNodeSource = PrtfElement | GroupNode;

/**
 * A single tree node, wrapping either a real parsed element (file/record/field/constant/attribute)
 * or a synthetic organizational group. `lineIndex`, when present on the wrapped element, is what
 * lets the extension navigate the source editor to this node on selection. `id` is stable across
 * re-renders (derived from the underlying data, not object identity) so VS Code can match up tree
 * items for `TreeView.reveal()`.
 */
export class PrtfNode extends vscode.TreeItem {
	constructor(
		id: string,
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly source: PrtfNodeSource
	) {
		super(label, collapsibleState);
		this.id = id;
		this.contextValue = source.kind;
	};
};

/**
 * Tree data provider for the "Definition" view: Records > (Attributes, Fields and Constants) >
 * (Indicators, Attributes) per field/constant. Built directly from the flat element array the
 * parser returns — records/fields/constants are correlated by `recordname`/`lineIndex` rather than
 * mutable global state, so the provider stays a pure function of whatever was last parsed.
 */
export class PrtfTreeProvider implements vscode.TreeDataProvider<PrtfNode> {
	private _onDidChangeTreeData: vscode.EventEmitter<PrtfNode | undefined | void> = new vscode.EventEmitter<PrtfNode | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<PrtfNode | undefined | void> = this._onDidChangeTreeData.event;

	private hasActiveDocument = false;
	private elements: PrtfElement[] = [];

	setHasActiveDocument(value: boolean) {
		this.hasActiveDocument = value;
		if (!value) {this.elements = [];}
		this.refresh();
	};

	setElements(elements: PrtfElement[]) {
		this.elements = elements;
		this.refresh();
	};

	refresh(): void {
		this._onDidChangeTreeData.fire();
	};

	getTreeItem(element: PrtfNode): vscode.TreeItem {
		return element;
	};

	getChildren(element?: PrtfNode): PrtfNode[] {
		if (!element) {return this.getRootChildren();}

		const source = element.source;
		switch (source.kind) {
			case 'treeGroup':
				return this.wrapChildren(source.children);
			case 'record':
				return this.getRecordChildren(source);
			case 'field':
			case 'constant':
				return this.getFieldOrConstantChildren(source);
			default:
				return [];
		};
	};

	/**
	 * Reconstructs a node's parent from its own data alone (record name / owning item), rather
	 * than a live tree-walk — required for `TreeView.reveal()` to work on nodes below the root.
	 */
	getParent(element: PrtfNode): PrtfNode | undefined {
		const source = element.source;

		if (source.kind === 'field' || source.kind === 'constant') {
			const record = this.findRecord(source.recordname);
			return record ? this.recordFieldsGroup(record) : undefined;
		};

		if (source.kind === 'record') {
			return this.recordsRootGroup();
		};

		if (source.kind === 'treeGroup') {
			switch (source.role) {
				case 'file':
				case 'records':
					return undefined;
				case 'recordAttrs':
				case 'recordFields': {
					const record = this.findRecord(source.recordName!);
					return record ? recordNode(record) : undefined;
				};
				case 'itemIndicators':
				case 'itemAttrs': {
					const item = this.findFieldOrConstant(source.recordName!, source.itemLineIndex!);
					if (!item) {return undefined;}
					return item.kind === 'field' ? fieldNode(item) : constantNode(item);
				};
				case 'leafGroup':
					return undefined; // Leaf groups (individual indicators) are never revealed directly.
			};
		};

		return undefined;
	};

	/** Builds (without needing it to already be part of a rendered tree) the node for a specific
	 * field/constant, so the preview's click-to-navigate can reveal/select it in this tree too. */
	buildNodeFor(recordName: string, lineIndex: number): PrtfNode | undefined {
		const item = this.findFieldOrConstant(recordName, lineIndex);
		if (!item) {return undefined;}
		return item.kind === 'field' ? fieldNode(item) : constantNode(item);
	};

	private findRecord(recordName: string): PrtfRecord | undefined {
		return this.elements.find((e): e is PrtfRecord => e.kind === 'record' && e.name === recordName);
	};

	private findFieldOrConstant(recordName: string, lineIndex: number): PrtfField | PrtfConstant | undefined {
		return this.elements.find(
			(e): e is PrtfField | PrtfConstant =>
				(e.kind === 'field' || e.kind === 'constant') && e.recordname === recordName && e.lineIndex === lineIndex
		);
	};

	private recordsRootGroup(): PrtfNode {
		const records = this.elements.filter((e): e is PrtfRecord => e.kind === 'record');
		return wrapGroup({ kind: 'treeGroup', role: 'records', id: 'grp:records', label: '📂 Records', children: records }, vscode.TreeItemCollapsibleState.Expanded);
	};

	private recordFieldsGroup(record: PrtfRecord): PrtfNode {
		const fieldsAndConstants = this.fieldsAndConstantsOf(record.name);
		return fieldsAndConstantsGroupNode(record.name, fieldsAndConstants);
	};

	private fieldsAndConstantsOf(recordName: string): (PrtfField | PrtfConstant)[] {
		return this.elements
			.filter((e): e is PrtfField | PrtfConstant => (e.kind === 'field' || e.kind === 'constant') && e.recordname === recordName)
			.sort((a, b) => a.lineIndex - b.lineIndex);
	};

	private getRootChildren(): PrtfNode[] {
		if (!this.hasActiveDocument) {
			return [placeholderNode('Open a PRTF source member')];
		};

		const records = this.elements.filter((e): e is PrtfRecord => e.kind === 'record');
		if (records.length === 0) {
			return [placeholderNode('No records found')];
		};

		const fileNode = this.elements.find(e => e.kind === 'file');
		const fileAttributes = (fileNode as any)?.attributes as PrtfAttribute[] | undefined;

		const nodes: PrtfNode[] = [];
		if (fileAttributes && fileAttributes.length > 0) {
			const fileGroup: GroupNode = { kind: 'treeGroup', role: 'file', id: 'grp:file', label: '📂 File', children: fileAttributes };
			nodes.push(wrapGroup(fileGroup, vscode.TreeItemCollapsibleState.Collapsed));
		};

		nodes.push(this.recordsRootGroup());

		return nodes;
	};

	private getRecordChildren(record: PrtfRecord): PrtfNode[] {
		const nodes: PrtfNode[] = [];
		nodes.push(recordAttrsGroupNode(record));
		nodes.push(this.recordFieldsGroup(record));
		return nodes;
	};

	private getFieldOrConstantChildren(element: PrtfField | PrtfConstant): PrtfNode[] {
		const nodes: PrtfNode[] = [];
		nodes.push(itemIndicatorsGroupNode(element));
		nodes.push(itemAttrsGroupNode(element));
		return nodes;
	};

	private wrapChildren(children: PrtfNodeSource[]): PrtfNode[] {
		return children.map(child => this.wrapOne(child));
	};

	private wrapOne(source: PrtfNodeSource): PrtfNode {
		if (source.kind === 'treeGroup') {
			const collapsible = source.children.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None;
			return wrapGroup(source, collapsible);
		};
		if (source.kind === 'record') {
			return recordNode(source);
		};
		if (source.kind === 'field') {
			return fieldNode(source);
		};
		if (source.kind === 'constant') {
			return constantNode(source);
		};
		// 'attribute' (leaf, e.g. inside an Attributes group)
		const attr = source as PrtfAttribute;
		return new PrtfNode(`attr:${attr.lineIndex}:${attr.value}`, `⚙️ ${attr.value}`, vscode.TreeItemCollapsibleState.None, attr);
	};
};

function wrapGroup(group: GroupNode, collapsibleState: vscode.TreeItemCollapsibleState): PrtfNode {
	return new PrtfNode(group.id, group.label, collapsibleState, group);
};

function placeholderNode(message: string): PrtfNode {
	return new PrtfNode('placeholder', message, vscode.TreeItemCollapsibleState.None, { kind: 'treeGroup', role: 'leafGroup', id: 'placeholder', label: message, children: [] });
};

function recordNode(record: PrtfRecord): PrtfNode {
	return new PrtfNode(`rec:${record.name}`, `📄 ${record.name}`, vscode.TreeItemCollapsibleState.Collapsed, record);
};

function fieldNode(field: PrtfField): PrtfNode {
	const collapsible = (field.indicators?.length ?? 0) > 0 || (field.attributes?.length ?? 0) > 0
		? vscode.TreeItemCollapsibleState.Collapsed
		: vscode.TreeItemCollapsibleState.None;
	const node = new PrtfNode(`fld:${field.recordname}:${field.lineIndex}`, `🔤 ${field.name}`, collapsible, field);
	node.description = describePrtfField(field);
	node.tooltip = indicatorTooltip(field.indicators);
	return node;
};

function constantNode(constant: PrtfConstant): PrtfNode {
	const collapsible = (constant.indicators?.length ?? 0) > 0 || (constant.attributes?.length ?? 0) > 0
		? vscode.TreeItemCollapsibleState.Collapsed
		: vscode.TreeItemCollapsibleState.None;
	const node = new PrtfNode(`cst:${constant.recordname}:${constant.lineIndex}`, `💡 ${constant.name}`, collapsible, constant);
	node.description = describePrtfConstant(constant);
	node.tooltip = indicatorTooltip(constant.indicators);
	return node;
};

function recordAttrsGroupNode(record: PrtfRecord): PrtfNode {
	const attributes = record.attributes ?? [];
	const group: GroupNode = {
		kind: 'treeGroup', role: 'recordAttrs', id: `grp:rec:${record.name}:attrs`,
		label: `⚙️ Attributes (${attributes.length})`, recordName: record.name, children: attributes
	};
	return wrapGroup(group, attributes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
};

function fieldsAndConstantsGroupNode(recordName: string, fieldsAndConstants: (PrtfField | PrtfConstant)[]): PrtfNode {
	const group: GroupNode = {
		kind: 'treeGroup', role: 'recordFields', id: `grp:rec:${recordName}:fields`,
		label: `🧾 Fields and Constants (${fieldsAndConstants.length})`, recordName, children: fieldsAndConstants
	};
	return wrapGroup(group, fieldsAndConstants.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
};

function itemAttrsGroupNode(item: PrtfField | PrtfConstant): PrtfNode {
	const attributes = item.attributes ?? [];
	const group: GroupNode = {
		kind: 'treeGroup', role: 'itemAttrs', id: `grp:item:${item.recordname}:${item.lineIndex}:attrs`,
		label: `⚙️ Attributes (${attributes.length})`, recordName: item.recordname, itemLineIndex: item.lineIndex, children: attributes
	};
	return wrapGroup(group, attributes.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
};

function itemIndicatorsGroupNode(item: PrtfField | PrtfConstant): PrtfNode {
	const list = item.indicators ?? [];
	const group: GroupNode = {
		kind: 'treeGroup', role: 'itemIndicators', id: `grp:item:${item.recordname}:${item.lineIndex}:ind`,
		label: `📶 Indicators (${list.length})`, recordName: item.recordname, itemLineIndex: item.lineIndex,
		children: list.map((ind, i): GroupNode => ({
			kind: 'treeGroup', role: 'leafGroup', id: `grp:item:${item.recordname}:${item.lineIndex}:ind:${i}`,
			label: `${String(ind.number).padStart(2, '0')}: ${ind.active ? 'ON' : 'OFF'}`, children: []
		}))
	};
	return wrapGroup(group, list.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
};

/** e.g. "(30)A [2,26]" — length/decimals, type, [row,col]. Flags P (program-to-system) fields. */
function describePrtfField(field: PrtfField): string {
	const size = field.decimals ? `(${field.length},${field.decimals})` : `(${field.length})`;
	const position = field.row !== undefined && field.column !== undefined ? ` [${field.row},${field.column}]` : '';
	const flags = [
		field.programToSystem ? 'P2S' : undefined,
		field.referenced ? 'Ref' : undefined
	].filter(Boolean);
	const flagText = flags.length > 0 ? ` (${flags.join(', ')})` : '';
	return `${size}${field.type ?? ''}${position}${flagText}`;
};

/** e.g. "[2,50]" — [row,col]. */
function describePrtfConstant(constant: PrtfConstant): string {
	return `[${constant.row},${constant.column}]`;
};

/** Compact "51 AND NOT 61 AND 53  OR  52" form for a field/constant/attribute's tooltip. */
function indicatorTooltip(indicators: PrtfIndicator[] | undefined): string | undefined {
	if (!indicators || indicators.length === 0) {return undefined;}
	const groups = groupIndicatorsByCondition(indicators);
	const groupText = groups.map(group =>
		group.map(ind => `${ind.active ? '' : 'NOT '}${ind.number}`).join(' AND ')
	).join('  OR  ');
	return `Active when: ${groupText}`;
};

/**
 * Reveals and selects a field/constant in the "Definition" tree — used to keep the preview's
 * click-to-navigate in sync with the tree, same as it already is with the source editor.
 * A no-op if the tree/provider aren't available yet or the target can't be found.
 */
export function revealInTree(recordName: string, lineIndex: number): void {
	const treeProvider = ExtensionState.treeProvider as PrtfTreeProvider | undefined;
	const treeView = ExtensionState.treeView as vscode.TreeView<PrtfNode> | undefined;
	if (!treeProvider || !treeView) {return;}

	const node = treeProvider.buildNodeFor(recordName, lineIndex);
	if (!node) {return;}

	treeView.reveal(node, { select: true, focus: false, expand: true }).then(undefined, () => {
		// Reveal can reject if the tree hasn't finished (re)rendering yet after a fast series of
		// clicks — harmless to ignore, the next selection/refresh will settle it.
	});
};

/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.providers.ts
*/

import * as vscode from 'vscode';

/**
 * Placeholder tree data provider for the "Definition" view.
 * Will be replaced by a real tree (records/fields/constants) once the PRTF
 * parser and model exist (see project roadmap) — for now it just confirms
 * the view is wired up correctly for `dds.prtf` documents.
 */
export class PrtfTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

	private hasActiveDocument = false;

	setHasActiveDocument(value: boolean) {
		this.hasActiveDocument = value;
		this.refresh();
	};

	refresh(): void {
		this._onDidChangeTreeData.fire();
	};

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	};

	getChildren(): vscode.TreeItem[] {
		const message = this.hasActiveDocument
			? 'Parser not implemented yet'
			: 'Open a PRTF source member';
		return [new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None)];
	};
};

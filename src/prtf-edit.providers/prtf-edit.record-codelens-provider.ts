/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.record-codelens-provider.ts
*/

import * as vscode from 'vscode';
import { PrtfTreeProvider } from './prtf-edit.providers';
import { ExtensionState } from '../prtf-edit.states/state';

/**
 * Adds a "Preview (PRTF-edit)" CodeLens above each record definition, alongside whatever other
 * extensions (e.g. an IBM i DDS renderer) may already put their own "Preview" CodeLens there — a
 * separate extension's CodeLens command can't be redirected to ours, so this offers a second,
 * clearly labeled lens that opens this extension's own preview panel for that record instead.
 */
export class PrtfRecordCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	constructor(private readonly treeProvider: PrtfTreeProvider) {
		treeProvider.onDidChangeTreeData(() => this._onDidChangeCodeLenses.fire());
	};

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		// Only the actively-tracked PRTF document has a parsed element list to draw record
		// positions from (see ExtensionState.lastPrtfDocument and the tree provider's single-document
		// model) — a background/inactive PRTF document simply gets no lenses.
		if (document !== ExtensionState.lastPrtfDocument) {return [];};

		const records = this.treeProvider.getElements().filter(el => el.kind === 'record');

		return records.map(record => new vscode.CodeLens(
			new vscode.Range(record.lineIndex, 0, record.lineIndex, 0),
			{
				title: 'Preview (PRTF-edit)',
				command: 'prtf-edit.preview-record-by-name',
				arguments: [record.name]
			}
		));
	};
};

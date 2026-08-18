/*
    Christian Larsen, 2026
    "PRTF structure"
    listeners/listeners.ts
*/

import * as vscode from 'vscode';
import { PrtfTreeProvider } from '../prtf-edit.providers/prtf-edit.providers';
import { ExtensionState } from '../prtf-edit.states/state';
import { parseDocument } from '../prtf-edit.parser/prtf-edit.parser';
import { RecordPreviewPanel } from '../prtf-edit.webview/prtf-edit.record-preview-panel';
import { validatePositioningConflicts } from '../prtf-edit.validation/prtf-edit.validation';

const PRTF_LANGUAGE_ID = 'dds.prtf';
const DEBOUNCE_MS = 300;

function generateStructure(treeProvider: PrtfTreeProvider, document: vscode.TextDocument): void {
    const elements = parseDocument(document.getText());
    ExtensionState.lastPrtfElements = elements;
    treeProvider.setElements(elements);
    RecordPreviewPanel.refreshIfOpen(elements);
    ExtensionState.diagnosticCollection.set(document.uri, validatePositioningConflicts(elements));
};

function debounceUpdate(treeProvider: PrtfTreeProvider, document: vscode.TextDocument): void {
    ExtensionState.clearTimeout();
    ExtensionState.updateTimeout = setTimeout(() => generateStructure(treeProvider, document), DEBOUNCE_MS);
};

function trackIfPrtf(treeProvider: PrtfTreeProvider, document: vscode.TextDocument | undefined, editor: vscode.TextEditor | undefined) {
    if (document && document.languageId === PRTF_LANGUAGE_ID) {
        ExtensionState.lastPrtfDocument = document;
        ExtensionState.lastPrtfEditor = editor;
        treeProvider.setHasActiveDocument(true);
        generateStructure(treeProvider, document);
    } else if (ExtensionState.lastPrtfDocument) {
        // No new PRTF document became active — most commonly because focus moved to a non-editor
        // part of the UI (our own preview webview, the terminal, another sidebar), which reports
        // vscode.window.activeTextEditor as undefined even though the PRTF file is still open.
        // Keep following whatever was already tracked instead of clearing it; only
        // onDidCloseTextDocument clears tracking, when that document is genuinely gone.
        treeProvider.setHasActiveDocument(true);
    } else {
        treeProvider.setHasActiveDocument(false);
    };
};

export function initializeDocumentListeners(
    context: vscode.ExtensionContext,
    treeProvider: PrtfTreeProvider
) {
    trackIfPrtf(treeProvider, vscode.window.activeTextEditor?.document, vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            trackIfPrtf(treeProvider, editor?.document, editor);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            // Compare against the tracked PRTF document, not vscode.window.activeTextEditor: the
            // latter can be undefined or point elsewhere while a non-editor part of the UI has
            // focus (e.g. the tree view itself), which would otherwise skip refreshing after edits.
            if (event.document === ExtensionState.lastPrtfDocument) {
                debounceUpdate(treeProvider, event.document);
            };
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            if (ExtensionState.lastPrtfDocument && document === ExtensionState.lastPrtfDocument) {
                ExtensionState.clearTimeout();
                ExtensionState.lastPrtfDocument = undefined;
                ExtensionState.lastPrtfEditor = undefined;
                ExtensionState.lastPrtfElements = [];
                treeProvider.setHasActiveDocument(false);
            };
            ExtensionState.diagnosticCollection.delete(document.uri);
        })
    );
};

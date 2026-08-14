/*
    Christian Larsen, 2026
    "PRTF structure"
    listeners/listeners.ts
*/

import * as vscode from 'vscode';
import { PrtfTreeProvider } from '../prtf-edit.providers/prtf-edit.providers';
import { ExtensionState } from '../prtf-edit.states/state';

const PRTF_LANGUAGE_ID = 'dds.prtf';

function trackIfPrtf(treeProvider: PrtfTreeProvider, document: vscode.TextDocument | undefined, editor: vscode.TextEditor | undefined) {
    if (document && document.languageId === PRTF_LANGUAGE_ID) {
        ExtensionState.lastPrtfDocument = document;
        ExtensionState.lastPrtfEditor = editor;
        treeProvider.setHasActiveDocument(true);
    } else {
        ExtensionState.lastPrtfDocument = undefined;
        ExtensionState.lastPrtfEditor = undefined;
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
        vscode.workspace.onDidCloseTextDocument(document => {
            if (ExtensionState.lastPrtfDocument && document === ExtensionState.lastPrtfDocument) {
                ExtensionState.clearTimeout();
                ExtensionState.lastPrtfDocument = undefined;
                ExtensionState.lastPrtfEditor = undefined;
                treeProvider.setHasActiveDocument(false);
            };
        })
    );
};

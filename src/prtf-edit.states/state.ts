/*
    Christian Larsen, 2026
    "PRTF structure"
    states/state.ts
*/

import * as vscode from 'vscode';
import { PrtfElement } from '../prtf-edit.model/prtf-edit.model';

export class ExtensionState {

    static lastPrtfDocument: vscode.TextDocument | undefined;
    static lastPrtfEditor: vscode.TextEditor | undefined;
    /** The most recently parsed structure for lastPrtfDocument — cached so cursor-driven preview
     * sync (on every selection change) doesn't need to re-parse the whole document each time. */
    static lastPrtfElements: PrtfElement[] = [];
    static updateTimeout: NodeJS.Timeout | undefined;
    static treeProvider: any;
    static treeView: any;
    static diagnosticCollection: vscode.DiagnosticCollection;

    static clearTimeout() {
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = undefined;
        };
    };
};

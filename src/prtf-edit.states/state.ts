/*
    Christian Larsen, 2026
    "PRTF structure"
    states/state.ts
*/

import * as vscode from 'vscode';

export class ExtensionState {

    static lastPrtfDocument: vscode.TextDocument | undefined;
    static lastPrtfEditor: vscode.TextEditor | undefined;
    static updateTimeout: NodeJS.Timeout | undefined;
    static treeProvider: any;

    static clearTimeout() {
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = undefined;
        };
    };
};

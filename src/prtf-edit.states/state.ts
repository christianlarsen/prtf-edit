/*
    Christian Larsen, 2026
    "PRTF structure"
    states/state.ts
*/

import * as vscode from 'vscode';
import { PrtfElement } from '../prtf-edit.model/prtf-edit.model';

export class ExtensionState {

    static lastPrtfDocument: vscode.TextDocument | undefined;
    /** The most recently active PRTF editor — kept even after it stops being VS Code's own
     * `activeTextEditor` (e.g. the preview webview or tree view has focus, or the preview's
     * "Focus" mode has maximized its own editor group away). Letting the source editor's own
     * selection/reveal be driven directly through this tracked object, instead of
     * `showTextDocument`, is what lets tree/preview navigation update the cursor without
     * surfacing (and un-maximizing) a hidden source editor group — see
     * prtf-edit.navigation.ts's revealLine. */
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

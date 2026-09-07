/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.configuration-panel.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { DECIMAL_FORMAT_OPTIONS, DecimalFormat, DEFAULT_DECIMAL_FORMAT, getDecimalFormat, resetDecimalFormat, setDecimalFormat } from '../prtf-edit.utils/prtf-edit.decimal-format';
import { DATE_SEPARATOR_OPTIONS, DateSeparatorFormat, DEFAULT_DATE_SEPARATOR_FORMAT, getDateSeparatorFormat, resetDateSeparatorFormat, setDateSeparatorFormat } from '../prtf-edit.utils/prtf-edit.date-format';
import { resolveDecimalFormatFromSystem, resolveDateSeparatorFormatFromSystem } from '../prtf-edit.ibmi/prtf-edit.ibmi-integration';
import { RecordPreviewPanel } from './prtf-edit.record-preview-panel';

/**
 * The extension's "⚙ Configuration" webview panel: lets the user choose the decimal/thousands-
 * separator convention (US/European) and the date-separator convention (US '/' / European '-')
 * used when previewing EDTCDE()-edited numeric fields and the bare DATE system-keyword constant,
 * either by hand or fetched from the connected IBM i's QDECFMT/QDATSEP system values. Reads and
 * writes straight to the extension's own stored settings (see
 * prtf-edit.utils/prtf-edit.decimal-format.ts and prtf-edit.utils/prtf-edit.date-format.ts), so
 * there's no separate state of its own: closing this panel loses nothing, since every change was
 * already saved the moment it was made — and it pushes each change straight to an open record
 * preview panel, if any.
 */
export class ConfigurationPanel {

	private static current: ConfigurationPanel | undefined;

	private readonly panel: vscode.WebviewPanel;

	private constructor() {
		this.panel = vscode.window.createWebviewPanel(
			'prtfEditConfiguration',
			'Configuration',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{ enableScripts: true }
		);

		this.panel.webview.html = this.getHtml();
		this.panel.webview.onDidReceiveMessage(message => this.onDidReceiveMessage(message));

		this.panel.onDidDispose(() => {
			if (ConfigurationPanel.current === this) {
				ConfigurationPanel.current = undefined;
			};
		});
	};

	/** Opens the panel, or reveals/refreshes it if it's already open. */
	static show(): void {
		if (ConfigurationPanel.current) {
			ConfigurationPanel.current.refresh();
			ConfigurationPanel.current.panel.reveal(vscode.ViewColumn.Beside, false);
			return;
		};
		ConfigurationPanel.current = new ConfigurationPanel();
	};

	/** Rebuilds the panel's HTML so its radios reflect the settings' current effective values. */
	private refresh(): void {
		this.panel.webview.html = this.getHtml();
	};

	/**
	 * Tells the already-open panel's own script which decimal format radio should be checked.
	 * Deliberately not done via `refresh()` (reassigning `webview.html`): VS Code skips the reload
	 * when the new html string is byte-identical to what's already loaded — which happens here
	 * whenever the resulting format matches whatever was baked into the panel's last real reload
	 * (e.g. picking a format by hand, with no intervening reload, then resetting back to the
	 * default already shown at panel-open time) — leaving the manually-picked radio visibly
	 * checked despite the setting having actually changed underneath it.
	 */
	private updateDecimalFormatRadio(): void {
		this.panel.webview.postMessage({ type: 'updateDecimalFormat', value: getDecimalFormat() });
	};

	/** Same as updateDecimalFormatRadio, for the date separator's radios. */
	private updateDateSeparatorRadio(): void {
		this.panel.webview.postMessage({ type: 'updateDateSeparator', value: getDateSeparatorFormat() });
	};

	private async onDidReceiveMessage(message: any): Promise<void> {
		switch (message?.type) {
			case 'setDecimalFormat':
				await setDecimalFormat(message.value as DecimalFormat);
				RecordPreviewPanel.refreshIfOpen(ExtensionState.lastPrtfElements);
				break;
			case 'resetDecimalFormat': {
				const changed = await resetDecimalFormat();
				this.updateDecimalFormatRadio();
				RecordPreviewPanel.refreshIfOpen(ExtensionState.lastPrtfElements);
				vscode.window.showInformationMessage(
					changed
						? `PRTF: decimal format reset to default (${DEFAULT_DECIMAL_FORMAT}).`
						: `PRTF: decimal format was already at its default (${DEFAULT_DECIMAL_FORMAT}).`
				);
				break;
			};
			case 'fetchDecimalFormatFromIBMi':
				try {
					const format = await resolveDecimalFormatFromSystem();
					await setDecimalFormat(format);
					this.updateDecimalFormatRadio();
					RecordPreviewPanel.refreshIfOpen(ExtensionState.lastPrtfElements);
					vscode.window.showInformationMessage(`PRTF: decimal format set to '${format}' from the connected IBM i (QDECFMT).`);
				} catch (error) {
					vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not read QDECFMT from the connected IBM i.');
				};
				break;
			case 'setDateSeparator':
				await setDateSeparatorFormat(message.value as DateSeparatorFormat);
				RecordPreviewPanel.refreshIfOpen(ExtensionState.lastPrtfElements);
				break;
			case 'resetDateSeparator': {
				const changed = await resetDateSeparatorFormat();
				this.updateDateSeparatorRadio();
				RecordPreviewPanel.refreshIfOpen(ExtensionState.lastPrtfElements);
				vscode.window.showInformationMessage(
					changed
						? `PRTF: date separator reset to default (${DEFAULT_DATE_SEPARATOR_FORMAT}).`
						: `PRTF: date separator was already at its default (${DEFAULT_DATE_SEPARATOR_FORMAT}).`
				);
				break;
			};
			case 'fetchDateSeparatorFromIBMi':
				try {
					const format = await resolveDateSeparatorFormatFromSystem();
					await setDateSeparatorFormat(format);
					this.updateDateSeparatorRadio();
					RecordPreviewPanel.refreshIfOpen(ExtensionState.lastPrtfElements);
					vscode.window.showInformationMessage(`PRTF: date separator set to '${format}' from the connected IBM i (QDATSEP).`);
				} catch (error) {
					vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not read QDATSEP from the connected IBM i.');
				};
				break;
		};
	};

	private getHtml(): string {
		const currentDecimalFormat = getDecimalFormat();
		const decimalFormatRows = DECIMAL_FORMAT_OPTIONS.map(opt => `
	<div class="row">
		<label class="radio-label">
			<input type="radio" name="decimalFormat" value="${opt.value}" ${opt.value === currentDecimalFormat ? 'checked' : ''}>
			${opt.label} — <span class="example">${opt.example}</span>
		</label>
	</div>`).join('');

		const currentDateSeparator = getDateSeparatorFormat();
		const dateSeparatorRows = DATE_SEPARATOR_OPTIONS.map(opt => `
	<div class="row">
		<label class="radio-label">
			<input type="radio" name="dateSeparator" value="${opt.value}" ${opt.value === currentDateSeparator ? 'checked' : ''}>
			${opt.label} — <span class="example">${opt.example}</span>
		</label>
	</div>`).join('');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
	body {
		font-family: var(--vscode-font-family, sans-serif);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 12px 16px;
	}
	h2 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 0 4px 0;
	}
	p.hint {
		font-size: 12px;
		opacity: 0.7;
		margin: 0 0 14px 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 0;
	}
	.example {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12px;
		opacity: 0.8;
	}
	.radio-label {
		flex: 1;
		font-size: 13px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.btn-secondary {
		margin-top: 8px;
		background: var(--vscode-button-secondaryBackground, transparent);
		color: var(--vscode-button-secondaryForeground, inherit);
		border: 1px solid var(--vscode-input-border, #555555);
		border-radius: 3px;
		padding: 4px 10px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn-secondary:hover {
		background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2));
	}
	hr.section {
		border: none;
		border-top: 1px solid var(--vscode-input-border, #555555);
		margin: 20px 0;
	}
</style>
</head>
<body>
<h2>Decimal Format</h2>
<p class="hint">Decimal point and thousands separator used when previewing EDTCDE()-edited numeric fields.</p>
${decimalFormatRows}
<div class="row" style="gap: 8px; margin-top: 8px;">
	<button id="fetchDecimalFormat" class="btn-secondary" style="margin-top: 0;">Fetch from IBM i</button>
	<button id="resetDecimalFormat" class="btn-secondary" style="margin-top: 0;">Reset to Default</button>
</div>

<hr class="section">

<h2>Date Separator</h2>
<p class="hint">Separator used when previewing a bare DATE system-keyword constant.</p>
${dateSeparatorRows}
<div class="row" style="gap: 8px; margin-top: 8px;">
	<button id="fetchDateSeparator" class="btn-secondary" style="margin-top: 0;">Fetch from IBM i</button>
	<button id="resetDateSeparator" class="btn-secondary" style="margin-top: 0;">Reset to Default</button>
</div>
<script>
	const vscode = acquireVsCodeApi();

	document.querySelectorAll('input[name="decimalFormat"]').forEach(input => {
		input.addEventListener('change', () => {
			vscode.postMessage({ type: 'setDecimalFormat', value: input.value });
		});
	});

	document.getElementById('fetchDecimalFormat').addEventListener('click', () => {
		vscode.postMessage({ type: 'fetchDecimalFormatFromIBMi' });
	});

	document.getElementById('resetDecimalFormat').addEventListener('click', () => {
		vscode.postMessage({ type: 'resetDecimalFormat' });
	});

	document.querySelectorAll('input[name="dateSeparator"]').forEach(input => {
		input.addEventListener('change', () => {
			vscode.postMessage({ type: 'setDateSeparator', value: input.value });
		});
	});

	document.getElementById('fetchDateSeparator').addEventListener('click', () => {
		vscode.postMessage({ type: 'fetchDateSeparatorFromIBMi' });
	});

	document.getElementById('resetDateSeparator').addEventListener('click', () => {
		vscode.postMessage({ type: 'resetDateSeparator' });
	});

	// Reset/Fetch don't reload the panel's html (see updateDecimalFormatRadio's comment on the
	// extension side for why) — they instead send this message so the already-live radios get
	// updated directly, without depending on a reload happening at all.
	window.addEventListener('message', event => {
		if (event.data?.type === 'updateDecimalFormat') {
			document.querySelectorAll('input[name="decimalFormat"]').forEach(input => {
				input.checked = input.value === event.data.value;
			});
		};
		if (event.data?.type === 'updateDateSeparator') {
			document.querySelectorAll('input[name="dateSeparator"]').forEach(input => {
				input.checked = input.value === event.data.value;
			});
		};
	});
</script>
</body>
</html>`;
	};
};

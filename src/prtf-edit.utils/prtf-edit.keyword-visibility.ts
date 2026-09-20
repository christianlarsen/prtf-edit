/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.keyword-visibility.ts
*/

import { ExtensionState } from '../prtf-edit.states/state';

/** The levels whose keywords the preview can list as clickable buttons — file (above the page), record (beside it), field/constant (in the toolbar once one is selected). */
export type KeywordLevel = 'file' | 'record' | 'field';

export const KEYWORD_LEVELS: KeywordLevel[] = ['file', 'record', 'field'];

const storageKey = (level: KeywordLevel) => `prtf-edit.viewKeywords.${level}`;

/**
 * Whether the preview shows the keyword buttons of `level` — stored in the extension's own global
 * storage (`ExtensionContext.globalState`), like the other Configuration settings. On for every
 * level until the user turns it off.
 */
export function getKeywordVisibility(level: KeywordLevel): boolean {
	return ExtensionState.context.globalState.get<boolean>(storageKey(level)) ?? true;
};

/**
 * Saves whether the preview shows the keyword buttons of `level`.
 * @param level - Which level to change
 * @param value - True to show that level's keywords, false to hide them
 */
export async function setKeywordVisibility(level: KeywordLevel, value: boolean): Promise<void> {
	await ExtensionState.context.globalState.update(storageKey(level), value);
};

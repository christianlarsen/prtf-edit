/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.spacing-marker.ts
*/

import { ExtensionState } from '../prtf-edit.states/state';

const STORAGE_KEY = 'prtf-edit.spacingMarkerAlwaysVisible';

/** Whether the spacing arrow is shown on every field/constant that has spacing, or only while hovering one — hover-only until the user opts in. */
export const DEFAULT_SPACING_MARKER_ALWAYS_VISIBLE = false;

/**
 * Reads whether the preview's spacing arrow (↑/↓/↕) is always visible — stored in the extension's
 * own global storage (`ExtensionContext.globalState`), same as the decimal format and date
 * separator. Falls back to the default when unset.
 */
export function getSpacingMarkerAlwaysVisible(): boolean {
	return ExtensionState.context.globalState.get<boolean>(STORAGE_KEY) ?? DEFAULT_SPACING_MARKER_ALWAYS_VISIBLE;
};

/**
 * Saves whether the spacing arrow is always visible, in the extension's own global storage.
 * @param value - True to always show it, false to show it only on hover
 */
export async function setSpacingMarkerAlwaysVisible(value: boolean): Promise<void> {
	await ExtensionState.context.globalState.update(STORAGE_KEY, value);
};

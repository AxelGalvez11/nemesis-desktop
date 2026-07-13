import { atom } from 'nanostores';
import { PREVIEW_PANE_ID, RIGHT_RAIL_SOURCES_TAB_ID, selectRightRailTab } from './layout';
import { setPaneOpen } from './panes';
export const $focusedSourceUrl = atom(null);
/** Open the Sources rail and request that its matching citation be revealed. */
export function focusSourceInRail(url) {
    setPaneOpen(PREVIEW_PANE_ID, true);
    selectRightRailTab(RIGHT_RAIL_SOURCES_TAB_ID);
    $focusedSourceUrl.set(url);
}

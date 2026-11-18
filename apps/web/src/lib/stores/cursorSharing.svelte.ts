import { getPreference, setPreference } from '#lib/utils/gameSessionPreferences.js';

/**
 * Whether the GM's cursor is mirrored onto the playfield. Client-local and
 * persisted in a cookie; on by default.
 */
class CursorSharingStore {
  enabled = $state(true);

  #initialized = false;

  // Client-only (reads cookies); call from onMount. Safe to call repeatedly.
  init() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.enabled = getPreference('shareCursor') ?? true;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    setPreference('shareCursor', enabled);
  }
}

export const cursorSharing = new CursorSharingStore();

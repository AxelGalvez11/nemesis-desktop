// Pure helpers for the post-stop transcript refine pass. The live captions
// (whisper-tiny.en) are saved to the lecture note immediately so nothing is lost;
// a background pass with the accurate batch model (whisper-base.en) then replaces
// the note's Transcript section — but ONLY if the section still holds exactly what
// we wrote. A student edit to that section always wins over the refine.
export const TRANSCRIPT_HEADING = '\n## Transcript\n\n';
export const EMPTY_TRANSCRIPT_BODY = '_no speech captured_';
/** Cap for the WASM fallback only — single-threaded whisper-base.en gets slow on
 *  long audio. The native parakeet engine (~20x realtime) uses the far higher
 *  NATIVE_REFINE_MAX_MS, which exists purely to bound renderer decode memory. */
export const AUTO_REFINE_MAX_MS = 30 * 60_000;
export const NATIVE_REFINE_MAX_MS = 3 * 60 * 60_000;
/**
 * Returns the note content with its Transcript section swapped for the refined
 * text, or null when the swap must not happen (no Transcript section, or the
 * section no longer matches the live transcript that was saved — i.e. the
 * student already edited it).
 */
export function replaceTranscriptSection(noteContent, savedLiveTranscript, refined) {
    const at = noteContent.indexOf(TRANSCRIPT_HEADING);
    if (at === -1) {
        return null;
    }
    const body = noteContent.slice(at + TRANSCRIPT_HEADING.length);
    const expected = savedLiveTranscript.trim() || EMPTY_TRANSCRIPT_BODY;
    if (body.trim() !== expected) {
        return null;
    }
    return `${noteContent.slice(0, at)}${TRANSCRIPT_HEADING}${refined.trim()}\n`;
}

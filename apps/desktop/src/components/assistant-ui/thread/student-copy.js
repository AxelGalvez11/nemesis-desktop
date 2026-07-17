import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
// "Checkpoint" is developer language. Same restore/rerun feature, but students
// see rewind words — overlay the handful of restore strings on t.assistant.thread.
const STUDENT_RESTORE_COPY = {
    restorePrevious: 'See the earlier version',
    restoreCheckpoint: 'Rewind',
    restoreFromHere: 'Rewind — ask this again from here',
    restoreTitle: 'Rewind to this message?',
    restoreBody: 'Everything after this message is cleared, and it runs again from here.',
    restoreConfirm: 'Rewind & ask again',
    restoreNext: 'See the newer version'
};
export function withStudentRestoreCopy(copy) {
    if (!NEMESIS_STUDENT_BUILD) {
        return copy;
    }
    return { ...copy, ...STUDENT_RESTORE_COPY };
}

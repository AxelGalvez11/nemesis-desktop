const DAY_MS = 24 * 60 * 60 * 1000;
const FSRS_DECAY = 19 / 81;
/** Project a deck's mean FSRS-4.5 retrievability from today through `days`. */
export function deckRetentionCurve(schedules, now, days = 21) {
    const eligible = schedules.flatMap(schedule => {
        if (!schedule.last_review || schedule.stability <= 0) {
            return [];
        }
        return [{ lastReview: new Date(schedule.last_review).getTime(), stability: schedule.stability }];
    });
    if (eligible.length === 0) {
        return [];
    }
    const finalDay = Math.max(0, Math.floor(days));
    return Array.from({ length: finalDay + 1 }, (_, day) => {
        const pointTime = now.getTime() + day * DAY_MS;
        const retention = eligible.reduce((sum, schedule) => {
            const elapsedDays = Math.max(0, (pointTime - schedule.lastReview) / DAY_MS);
            const retrievability = (1 + (FSRS_DECAY * elapsedDays) / schedule.stability) ** -0.5;
            return sum + retrievability;
        }, 0) / eligible.length;
        return { day, retention: Math.min(1, Math.max(0, retention)) };
    });
}

import { describe, expect, it } from 'vitest';
import { dueSlot } from './school-sync-schedule';
function at(hour) {
    return new Date(2026, 6, 12, hour, 0, 0);
}
describe('dueSlot', () => {
    it('never fires when auto-sync is off', () => {
        expect(dueSlot('off', at(8), null)).toBeNull();
        expect(dueSlot('off', at(20), null)).toBeNull();
    });
    it('fires the morning slot once the hour is reached, not before', () => {
        expect(dueSlot('daily', at(7), null)).toBeNull();
        expect(dueSlot('daily', at(8), null)).toBe('2026-7-12@8');
        expect(dueSlot('daily', at(11), null)).toBe('2026-7-12@8');
    });
    it('does not re-fire a slot already nudged today', () => {
        expect(dueSlot('daily', at(9), '2026-7-12@8')).toBeNull();
    });
    it('twice-daily surfaces only the latest passed slot (morning does not re-fire)', () => {
        expect(dueSlot('twice', at(19), '2026-7-12@8')).toBe('2026-7-12@18');
        expect(dueSlot('twice', at(19), '2026-7-12@18')).toBeNull();
        // Before evening: morning is the latest passed slot.
        expect(dueSlot('twice', at(9), null)).toBe('2026-7-12@8');
    });
    it('a new day re-arms the morning slot', () => {
        const tomorrow = new Date(2026, 6, 13, 8, 0, 0);
        expect(dueSlot('daily', tomorrow, '2026-7-12@8')).toBe('2026-7-13@8');
    });
});

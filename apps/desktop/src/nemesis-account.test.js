// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $account, getTrialTiming, initAccount, trialCountdownLabel } from './nemesis-account';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-12T18:00:00.000Z');
afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    $account.set({ plan: 'free', status: 'loading' });
});
describe('Nemesis trial timing', () => {
    it('uses Stripe trial_end for a live trial countdown', () => {
        const trialEnd = new Date(NOW + 7 * DAY_MS).toISOString();
        const timing = getTrialTiming({
            periodEnd: new Date(NOW + 30 * DAY_MS).toISOString(),
            plan: 'plus',
            planStatus: 'trialing',
            trialEnd
        }, NOW);
        expect(timing).toEqual({
            daysRemaining: 7,
            end: trialEnd,
            expired: false,
            inFinalThreeDays: false
        });
    });
    it('marks the final three days for one dismissible in-app reminder', () => {
        const timing = getTrialTiming({
            periodEnd: new Date(NOW + 3 * DAY_MS).toISOString(),
            plan: 'plus',
            planStatus: 'trialing'
        }, NOW);
        expect(timing?.daysRemaining).toBe(3);
        expect(timing?.inFinalThreeDays).toBe(true);
        expect(trialCountdownLabel(timing?.daysRemaining ?? 0)).toBe('Trial ends in 3 days');
        expect(trialCountdownLabel(1)).toBe('Trial ends in 1 day');
    });
    it('recognizes a trial that ended at its recorded subscription boundary', () => {
        const trialEnd = new Date(NOW - DAY_MS).toISOString();
        const timing = getTrialTiming({
            periodEnd: trialEnd,
            plan: 'free',
            planStatus: 'canceled',
            trialEnd
        }, NOW);
        expect(timing).toMatchObject({ daysRemaining: 0, expired: true, inFinalThreeDays: false });
    });
    it('does not label a later paid cancellation as an expired trial', () => {
        const timing = getTrialTiming({
            periodEnd: new Date(NOW + 20 * DAY_MS).toISOString(),
            plan: 'free',
            planStatus: 'canceled',
            trialEnd: new Date(NOW - 20 * DAY_MS).toISOString()
        }, NOW);
        expect(timing).toBeNull();
    });
    it('falls back to current_period_end when an older schema has no trial_end column', async () => {
        const fallbackTrialEnd = new Date(Date.now() + 7 * DAY_MS).toISOString();
        window.localStorage.setItem('nemesis.account.v1', JSON.stringify({
            accessToken: 'access-token',
            email: 'student@example.com',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            refreshToken: 'refresh-token',
            userId: 'student-id'
        }));
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('{}', { status: 400 }))
            .mockResolvedValueOnce(new Response(JSON.stringify([
            {
                current_period_end: fallbackTrialEnd,
                plan: 'plus',
                status: 'trialing',
                stripe_livemode: true
            }
        ]), { status: 200 }));
        await initAccount();
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('trial_end');
        expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('trial_end');
        expect($account.get()).toMatchObject({
            plan: 'plus',
            planStatus: 'trialing',
            trialEnd: fallbackTrialEnd
        });
    });
});

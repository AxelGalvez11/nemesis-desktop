export const NEMESIS_ONBOARDING_KEY = 'nemesis.onboarding.v1';
export function onboardingComplete() {
    return window.localStorage.getItem(NEMESIS_ONBOARDING_KEY) !== null;
}
export function completeOnboarding() {
    window.localStorage.setItem(NEMESIS_ONBOARDING_KEY, 'complete');
}
export function resetOnboarding() {
    window.localStorage.removeItem(NEMESIS_ONBOARDING_KEY);
}

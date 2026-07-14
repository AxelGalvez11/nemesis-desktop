import assert from 'node:assert/strict'
import test from 'node:test'

import { backendSyncBranchFrom, resolveBehindCount, shouldCountCommits } from './update-count'

// FAIL-BEFORE: pre-fix the function did `Number.parseInt(countStr) || 0`
// unconditionally, so a shallow checkout with no merge-base surfaced the bogus
// rev-list count (e.g. 12104). This asserts the new shallow/no-merge-base branch.
test('shallow checkout with no merge-base does NOT trust the bogus rev-list count', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '12104',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: true,
      hasMergeBase: false
    }),
    1
  )
})

test('shallow checkout with no merge-base but identical SHA reports up-to-date', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '12104',
      currentSha: 'abc',
      targetSha: 'abc',
      isShallow: true,
      hasMergeBase: false
    }),
    0
  )
})

test('shallow checkout WITH a merge-base keeps the exact count (reliable)', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '3',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: true,
      hasMergeBase: true
    }),
    3
  )
})

test('full (non-shallow) clone keeps the exact count path unchanged', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '7',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: false,
      hasMergeBase: true
    }),
    7
  )
})

test('up-to-date full clone reports 0', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '0',
      currentSha: 'x',
      targetSha: 'x',
      isShallow: false,
      hasMergeBase: true
    }),
    0
  )
})

test('non-numeric count falls back to 0 (defensive, unchanged behaviour)', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: false,
      hasMergeBase: true
    }),
    0
  )
})

// shouldCountCommits gates the expensive `rev-list --count` in checkUpdates().
// FAIL-BEFORE: in the shallow + no-merge-base case the caller ran rev-list
// unconditionally and discarded the bogus result; this predicate lets the
// caller SKIP the whole-ancestry enumeration in exactly that case (#51922).
test('shallow checkout with no merge-base SKIPS the rev-list count', () => {
  assert.equal(shouldCountCommits({ isShallow: true, hasMergeBase: false }), false)
})

test('shallow checkout WITH a merge-base still runs the count', () => {
  assert.equal(shouldCountCommits({ isShallow: true, hasMergeBase: true }), true)
})

test('full (non-shallow) clone always runs the count', () => {
  assert.equal(shouldCountCommits({ isShallow: false, hasMergeBase: true }), true)
  assert.equal(shouldCountCommits({ isShallow: false, hasMergeBase: false }), true)
})

// The skip path produces an empty countStr; resolveBehindCount must NOT trust
// it and must fall through to the SHA compare (mirrors the live call site).
test('skipped-count path resolves via SHA compare, never via empty countStr', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: true,
      hasMergeBase: false
    }),
    1
  )
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'same',
      targetSha: 'same',
      isShallow: true,
      hasMergeBase: false
    }),
    0
  )
})

// backendSyncBranchFrom gates the quit-for-update backend runtime sync.
// FAIL-BEFORE: nothing ever updated the runtime checkout on student installs —
// the app updated via electron-updater while ~/.nemesis/hermes-agent froze at
// install-day code (owner's was stuck at beta.3-era while the app was beta.10).
test('backendSyncBranchFrom returns the branch only for a clean behind>0 check', () => {
  assert.equal(backendSyncBranchFrom({ supported: true, behind: 3, branch: 'main' }), 'main')
  assert.equal(
    backendSyncBranchFrom({ supported: true, behind: 1, branch: 'codex/nemesis-beta-v0.1' }),
    'codex/nemesis-beta-v0.1'
  )
  // Missing branch falls back to main (matches DEFAULT_UPDATE_BRANCH).
  assert.equal(backendSyncBranchFrom({ supported: true, behind: 2 }), 'main')
})

test('backendSyncBranchFrom refuses ambiguous or up-to-date checks', () => {
  assert.equal(backendSyncBranchFrom(null), null)
  assert.equal(backendSyncBranchFrom(undefined), null)
  // Up to date — nothing to sync.
  assert.equal(backendSyncBranchFrom({ supported: true, behind: 0, branch: 'main' }), null)
  // Not a git checkout (e.g. pip install) — unsupported.
  assert.equal(backendSyncBranchFrom({ supported: false, reason: 'not-a-git-checkout' }), null)
  // Fetch failed (offline) — never sync on a stale/unknown picture.
  assert.equal(backendSyncBranchFrom({ supported: true, error: 'fetch-failed', behind: 1 }), null)
  // NaN/absent behind — no.
  assert.equal(backendSyncBranchFrom({ supported: true, branch: 'main' }), null)
})

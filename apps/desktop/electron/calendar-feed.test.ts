// Calendar-feed policy tests: the lenient parser, the publish window, the
// encrypted-doc content, and the ICS renderer — especially the hard privacy
// rule that `note` text never reaches the plaintext ICS output.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCalendarDocContent,
  parseCalendarFeedEvents,
  renderIcs,
  windowedEvents,
  WINDOW_FUTURE_DAYS,
  type CalendarFeedEvent
} from './calendar-feed'

const NOW = new Date(2026, 6, 17, 12, 0, 0) // 2026-07-17 local noon
const STAMP = new Date(Date.UTC(2026, 6, 17, 5, 0, 0))

const event = (over: Partial<CalendarFeedEvent>): CalendarFeedEvent => ({
  id: 'ev-1',
  title: 'Exam 2',
  date: '2026-07-20',
  kind: 'exam',
  ...over
})

test('parse keeps valid events and drops malformed ones individually', () => {
  const text = JSON.stringify({
    events: [
      { id: 'a', title: 'Exam', date: '2026-07-20', kind: 'exam', course: 'PHCY 1205', note: 'ch 4-6' },
      { id: 'b', title: 'No date', date: 'July 20', kind: 'exam' },
      { id: 'c', title: '', date: '2026-07-21', kind: 'exam' },
      { id: 'd', title: 'Bad kind', date: '2026-07-21', kind: 'party' },
      'garbage',
      { id: 'e', title: 'OK', date: '2026-07-22', kind: 'assignment', time: '14:00' }
    ]
  })
  const events = parseCalendarFeedEvents(text)

  assert.deepEqual(
    events.map(entry => entry.id),
    ['a', 'e']
  )
  assert.equal(events[0].note, 'ch 4-6')
  assert.equal(events[1].time, '14:00')
})

test('parse of non-JSON or shapeless JSON yields an empty list', () => {
  assert.deepEqual(parseCalendarFeedEvents('not json'), [])
  assert.deepEqual(parseCalendarFeedEvents('{"foo":1}'), [])
})

test('window keeps a week of history + half a year ahead, sorted by date then time', () => {
  const events = [
    event({ id: 'old', date: '2026-07-01' }), // 16 days back — out
    event({ id: 'recent', date: '2026-07-12' }), // 5 days back — in
    event({ id: 'later', date: '2026-07-20', time: '15:00' }),
    event({ id: 'earlier', date: '2026-07-20', time: '09:00' }),
    event({ id: 'far', date: '2027-04-01' }) // > WINDOW_FUTURE_DAYS — out
  ]
  const windowed = windowedEvents(events, NOW)

  assert.ok(WINDOW_FUTURE_DAYS < 259) // guard: 'far' really is outside the window
  assert.deepEqual(
    windowed.map(entry => entry.id),
    ['recent', 'earlier', 'later']
  )
})

test('doc content carries feedUrl, asOf and full events (notes included — it ships encrypted)', () => {
  const content = buildCalendarDocContent([event({ note: 'bring calculator' })], 'https://x/ics?token=t', '2026-07-17T00:00:00Z')
  const parsed = JSON.parse(content)

  assert.equal(parsed.v, 1)
  assert.equal(parsed.feedUrl, 'https://x/ics?token=t')
  assert.equal(parsed.asOf, '2026-07-17T00:00:00Z')
  assert.equal(parsed.events[0].note, 'bring calculator')
})

test('ICS: untimed events render all-day, timed events render floating local + 1h', () => {
  const ics = renderIcs([event({}), event({ id: 'ev-2', date: '2026-07-21', time: '14:30', title: 'Lab' })], STAMP)

  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260720'))
  assert.ok(ics.includes('DTEND;VALUE=DATE:20260721'))
  assert.ok(ics.includes('DTSTART:20260721T143000'))
  assert.ok(ics.includes('DURATION:PT1H'))
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'))
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
})

test('ICS: note text NEVER appears; titles are escaped; course lands in the summary', () => {
  const ics = renderIcs(
    [
      event({
        title: 'Exam; part 1, alpha\nbeta',
        course: 'PHCY 1205',
        note: 'SECRET-NOTE-CONTENT'
      })
    ],
    STAMP
  )

  assert.ok(!ics.includes('SECRET-NOTE-CONTENT'))
  assert.ok(ics.includes('SUMMARY:Exam\\; part 1\\, alpha\\nbeta (PHCY 1205)'))
})

test('ICS: byte-identical for the same inputs + stamp, and every line folds under 76 chars', () => {
  const long = event({ title: 'A'.repeat(140), id: 'x'.repeat(90) })
  const first = renderIcs([long], STAMP)
  const second = renderIcs([long], STAMP)

  assert.equal(first, second)
  for (const line of first.split('\r\n')) {
    assert.ok(line.length <= 75, `line too long: ${line.length}`)
  }
  assert.ok(first.includes(`DTSTAMP:20260717T050000Z`))
})

test('ICS: out-of-range times fall back to all-day instead of emitting invalid DTSTART', () => {
  const ics = renderIcs(
    [event({ id: 'bad-time', time: '25:99' }), event({ id: 'ok-time', date: '2026-07-21', time: '9:05' })],
    STAMP
  )

  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260720')) // 25:99 → all-day
  assert.ok(ics.includes('DTSTART:20260721T090500')) // 9:05 stays timed
})

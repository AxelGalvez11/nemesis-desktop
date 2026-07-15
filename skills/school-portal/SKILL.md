---
name: school-portal
description: Check the student's LMS (Blackboard/Canvas/Brightspace/…) and school email — read courses, announcements, inbox — read-only, no submitting. Portal addresses come from .nemesis/portals.json.
version: 1.2.0
metadata:
  hermes:
    tags: [school, blackboard, outlook, portal, email, courses, academic]
---

# School portal extraction (any LMS + school email)

Use this skill when the student asks you to check their school portal, pull course
materials, summarize announcements, or triage school email. You have real browser
automation tools (browser_navigate, browser_snapshot, browser_click, browser_type,
browser_scroll, browser_press, browser_back, plus browser_console/browser_cdp to run
JavaScript in the page) — use them for the student's LMS, their web email, and similar
school sites that have no public API. Blackboard and Outlook are the running EXAMPLES
throughout this skill, but the student's LMS may be Canvas, Brightspace, Moodle, or
Schoology; read their actual addresses from `portals.json` (below) and apply the closest
pattern here.

**Fast extraction (the #1 cost rule here):** prefer ONE `browser_console` call that returns
structured data via `Runtime.evaluate` over a click → snapshot → click loop — and do this
**not just on list pages but INSIDE each page too.** On a course's Content page, one eval
returns every item as `{title, type, dueDate, href}`; on an assignment page, one eval
returns the prompt + rubric + attachment links. A screenshot/snapshot re-read of a page is
the expensive path (it sits in context and is re-read every later step); the console eval
returns compact text once. Reserve click+snapshot for actually opening/downloading one item.

**Save what works so it runs free next time.** For a workflow you'll repeat (a portal
sweep), once your `browser_console` extraction scripts return the right data, save them with
`browser_recipe_save` (navigate + eval steps). Future runs `browser_recipe_run` them with
zero model calls; if the page later changes the run returns `"stale": true` and you just
re-discover and re-save. See nemesis-school-sync for the recipe-first sweep flow.

## Hard rules (non-negotiable)

1. **Never submit anything.** Do not click Submit, Send, Post, Reply, or any button that
   publishes on the student's behalf — no assignment submissions, no discussion posts, no
   emails sent. You prepare drafts and summaries; the student submits. If a task seems to
   require submitting, stop and tell the student to do that step themselves.
2. **Never change account settings**, forwarding rules, passwords, or sharing permissions.
3. **Login belongs to the student.** If a page asks for credentials or two-factor codes,
   pause and tell the student to complete the login. Never ask them to paste passwords
   into the chat.
4. **Read-only bias.** Navigation, reading, and downloading course materials the student
   already has access to are fine. Anything that writes to the portal is not.
5. **Budget the job (don't run away).** A portal sweep should be tens of steps, not
   hundreds. If a task is ballooning past ~25 browser steps without finishing, STOP and
   tell the student what you've got so far and what's left, rather than looping — a runaway
   browser loop is the single most expensive thing this skill can do. Extract in bulk
   (above) so you rarely get near the limit.

## Portal addresses: read them from portals.json

The app is the source of truth for the student's own portal addresses. Before any portal
work, read `~/Documents/Nemesis Library/.nemesis/portals.json`:

```json
{ "portals": [
  { "kind": "lms",   "name": "Canvas",  "url": "https://canvas.myschool.edu/" },
  { "kind": "email", "name": "Outlook", "url": "https://outlook.cloud.microsoft/mail/" }
] }
```

Navigate to those exact `url`s. If the file is missing or lacks the entry you need
(`lms` for course work, `email` for webmail), ask the student in chat — "What's your
school's course site address?" — then write `portals.json` YOURSELF in the format above
(create the `.nemesis` folder if needed, keep any existing entries) and confirm what you
saved. The file is the durable memory: the next sweep reads it and never has to ask
again. Same when they say an address changed — update the file. Do NOT guess and do NOT
fall back to an example address; a wrong school is worse than asking. (2026-07-14: the
Settings → Connections page is hidden — chat is the only door for portal setup.)

## Blackboard flow

1. Navigate to the school's Blackboard URL from memory (see above).
2. After the student completes login, snapshot the page.
3. Click the **hamburger button** ("Open main navigation") to reveal all sections:
   Courses, Institution Page, Calendar, Grades, Messages, Tools.
4. Open **Courses** — the page may default to a past term. Use **Filters dropdown →
   Terms → "Current Courses"** and close the filter panel to see active courses.
5. For each active (Open) course:
   - Check **Content** (default landing — posted files, assessments with due dates)
   - Check **Announcements** (separate tab — not shown on Content page)
   - Items to note: name, type, due date, "Start attempt" status
   - Closed courses block entry with a dismissable alert dialog — press Escape.
6. Check the **Institution Page** via the nav menu for IT/help announcements and
   resource links (Simple Syllabus issues, Safari workarounds, etc.).
7. Save a consolidated **daily brief** as Markdown into
   `~/Documents/Nemesis Library/School/Daily brief — Blackboard YYYY-MM-DD.md`.
   Order: due-soon list first, then new materials, then announcements, each with
   its course tag. End with a note that Outlook is checked separately.
8. To CAPTURE a file the student asks for: click its download link in the browser
   (it lands in `~/Downloads`), then move it with the terminal into
   `~/Documents/Nemesis Library/School/<Course>/`, and say where you put it.

> See `references/blackboard-ultra.md` for Blackboard Ultra navigation patterns.

## Outlook web flow

**Cost discipline (email is the #1 context burner — follow nemesis-email's rules here too):**
read the inbox list as METADATA first (subject, sender, date) via one bulk extraction;
classify from metadata; open the BODY of only the ~10 messages that look action/deadline-
relevant, one at a time; the moment a body yields its dates/actions, write them out and
summarize the email in one line — never keep raw bodies in the conversation (a sweep that
kept bodies once cost ~6M tokens). Only sweep mail newer than the last sync marker.

1. Navigate to the mail URL from memory (student logs in themselves). If the initial
   browser_snapshot returns an "(empty page)", do NOT assume the session is dead —
   Outlook web renders content dynamically. Check `document.title` via browser_console:
   if it contains "Mail - <Name> - Outlook" the user IS logged in; the page just needs
   a moment or a second snapshot to populate.
2. Snapshot the inbox list. The inbox groups emails into **Pinned**, **Today**,
   **Yesterday**, **This week**, and **Older** sections. Read each section.
3. **Opening an email:** clicking a conversation header (the top-level option in the
   listbox) expands/collapses it — it does NOT open a reading pane. To see the email
   body, you must click the **"Expand conversation"** button inside the option, then
   click a **specific sub-message** (listitem inside the expanded list). This opens the
   reading pane on the right. The close button hides the pane.
4. **Finding pinned/older emails not visible in the inbox:** The default inbox view
   may not show all pinned emails (conversation grouping can subsume them). Use the
   search box (`browser_type` into the combobox + `browser_press` Enter) to find a
   specific email by subject or sender — search returns results even when the item is
   off-screen or aggregated into a conversation.
5. **Attachments:** Outlook web renders attachments dynamically (served via OneDrive /
   SharePoint). They are NOT static download URLs accessible to the browser tool. You
   **cannot auto-download attachments from Outlook web** — even if the email shows a
   "Has attachments" badge and you open it in the reading pane, the attachment tiles
   are hosted behind signed OneDrive URLs that the browser tool can't fetch. If the
   student needs a file from an email, tell them to open that email manually in their
   own browser and download from there.
6. **SPA session pitfall:** After the browser navigates to a different site (e.g., PubMed,
   Blackboard) and then back to Outlook, the SPA may lose its message-list state. The
   page shows the app chrome, the user's name, and the folder pane — but the message
   list is empty. The user is still logged in; the SPA just needs a fresh page load.
   Navigate away and come back, or ask the student to visit Outlook once to restore it.
7. **CORE ELMS references:** Some IPPE/rotation emails reference documents hosted in
   the external **CORE ELMS** system (Student Handbook, IPPE Checklist, Pre-/Post-
   Reflections, Study Guides). These are not Blackboard files or email attachments.
   The student must log into CORE ELMS directly to download them.
8. **Downloaded files:** When you download files (via Blackboard's native download links
   that land in ~/Downloads), move them into course-specific subdirectories:
   `~/Documents/Nemesis Library/School/<Course-Name>/`. Create the folder if needed.
   Tell the student the exact filename and byte size (`ls -la` or `stat -f%z` on macOS).
9. Triage into: action needed (assignments, professor requests, registration deadlines),
   informational (newsletters, campus events), ignorable. Cite sender + date for each.
10. You may DRAFT replies in the chat for the student to copy. Never click Send.
11. Save the triage as a note in `~/Documents/Nemesis Library/School/Inbox brief <date>.md`
    when the student asks to keep it.

> See `references/outlook-web.md` for detailed Outlook web navigation patterns.

## Style

Summaries in plain English, newest first, always with dates. If a page fails to load or
the session expires, say exactly where you got stuck rather than guessing at content.

## Writing dates to the Calendar page

When you read due dates, exam dates, quiz windows, or rotation/IPPE dates from Blackboard or
Outlook, write them into `~/Documents/Nemesis Library/School/calendar.json` so they appear on
the app's Calendar page.

Shape: `{ "events": [{ "id", "title", "date": "yyyy-mm-dd", "time"?, "kind":
"assignment"|"exam"|"rotation"|"class"|"other", "course"?, "note"?, "source": "agent" }] }`

RULES — the student can also add their own events by hand in the app, so:
1. **Read-merge-write, never overwrite.** Read the existing file first; keep every event you
   didn't author (`source` ≠ "agent", or ids you don't recognize); add/update only your own.
2. Give your events stable ids (e.g. `bb-<course>-<slug>-<date>`) so re-running a brief
   UPDATES an event instead of duplicating it. Update in place when a date shifts.
3. Only remove an agent event when the source portal shows it's gone or its date passed —
   never remove a manual (`"source": "manual"`) event.
4. Always `"source": "agent"` on events you write; keep the JSON valid (validate after
   writing with a quick parse, e.g. `python3 -c "import json;json.load(open(...))"`).

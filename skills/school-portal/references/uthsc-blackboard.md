# UTHSC Blackboard Ultra — navigation reference

## Logged-in landing
After login, Blackboard Ultra renders inside an **iframe** (`notif-websockets-...` origin).  
Browser snapshots are from the iframe, not the parent page. This works — the iframe IS the app.

## Main navigation
Click the **hamburger button** ("Open main navigation") to reveal:
- Your name (profile)
- Institution Page
- Activity
- **Courses** ← main course list
- Organizations
- Calendar
- Messages
- Grades
- Tools
- Sign Out

## Finding active courses
Courses page defaults to the **last-viewed term** (e.g. "Spring 2026").  
To see currently active courses:

1. Click **"Filters dropdown"** button
2. In the **Terms** combobox, select **"Current Courses"**
3. Click **Close** to apply

The filter tags appear: `Current Courses` with a delete button.

## Course list grid
Each course card shows:
- Course name and code (e.g. "PHCY4000_45007_202640")
- Status badge: **Open** (active) or **Closed** (past — no access)
- Instructors (expandable "Multiple Instructors" button)
- Favorite/unfavorite star button

## Entering a closed course
Clicking a **Closed** course triggers an alert dialog:
> "You can't access this course right now. Your instructor will allow access when the course is ready."
>
> [OK] button

Dismiss with **Escape** or click OK (ref may shift — use `browser_press` key=Escape).

## Inside a course
Course page has a toolbar with links: Content, Calendar, Announcements, Discussions, Gradebook, Messages, Groups.

**Content page** is the default — shows all posted items.
- Empty course = "Content is on the way!"
- Items show: title, type badge, optional due date, "Start attempt N" for assessments
- Use **"Search course content"** link to find specific files

**Announcements** are under their own tab — not shown on the Content page.

## Course discovery pitfalls — integrated curricula (UTHSC P1)

P1 summer courses on UTHSC Blackboard do NOT always match their curriculum-common names or course codes in the agent's graph. **PHCY 1205 (Pharmacology) and PHCY 1210 (Infectious Disease)** — names used in the agent's graph — may not appear as separate Blackboard shells. They are often rolled into a larger integrated course block like:
- `Spring 2026: Dosage Dsgn, Deliv, Dispens II` (PHCY1210_24948)
- `Spring 2026: Integrated Pharmacotherapy 3` (PHCY1216_24951)
- `Spring 2026: Pharmacokinetics & Dose Opt` (PHCY1202_24945)

**Fallback — use browser_console to extract the full course list** when the accessibility snapshot truncates course names or only shows collapsed articles:
```js
// Extract all course headings
Array.from(document.querySelectorAll('article h4, article [role="heading"]'))
  .map(h => h.textContent.trim()).join('\n')

// Get full article data (name, status, code)
JSON.stringify(Array.from(document.querySelectorAll('article')).map(a => ({
  name: a.querySelector('h4')?.textContent?.trim() || 'no-h4',
  text: a.textContent.replace(/\s+/g, ' ').trim().substring(0, 300)
})))
```

**"Current Courses" may not show everything.** UTHSC sometimes groups summer P1 courses under "Spring 2026" term. Always check multiple terms:
1. **Current Courses** — usually shows HIPAA training, IPPE shells, open courses
2. **Spring 2026** — likely location for P1 summer course shells (may show "Closed" but content may still be accessible)
3. **Upcoming Courses** — next term's locked shells (Fall 2026, available from ~Jul 30)
4. **All Terms** — fallback; search by course code prefix (`"PHCY"`) to filter from 30+ results

**When graph courses don't match any Blackboard shell name** after checking all terms, flag it in the sync report and ask the student for the mapping — they may know the Blackboard course code (e.g. `PHCY1216_24951`) that differs from the curriculum number.

## Institution Page (notices/announcements)
URL: `https://blackboard.uthsc.edu/ultra/institution`  
Contains IT/help announcements from UTHSC:
- System issues (Simple Syllabus, Safari document errors, Blackboard mobile app)
- Resource links (CARE Team, TimelyCare, Library, Disability Services, etc.)
- Usually generic and rarely time-sensitive — check for new headings but don't expect changes every session.

## Daily brief workflow
After scanning courses + Institution Page:
1. Save note to `~/Documents/Nemesis Library/School/Daily brief — Blackboard YYYY-MM-DD.md`
2. Check Outlook separately (not auto-logged-in from Blackboard session — sign-in is independent)
3. End with a read-only disclaimer: nothing submitted or changed

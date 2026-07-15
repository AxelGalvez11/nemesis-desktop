# Blackboard Ultra — navigation reference

All URLs and course names below are EXAMPLES from a generic health-sciences campus.
Always navigate to the student's own LMS `url` from `portals.json` — never these.

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
- Course name and code (e.g. "PHAR1000_12345_202640")
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

## Course discovery pitfalls — integrated curricula

At schools with integrated curricula (common in pharmacy/medicine), courses on Blackboard
do NOT always match their curriculum-common names or course codes in the agent's graph.
A course the graph calls **"Pharmacology"** or **"Infectious Disease"** may not appear as
its own Blackboard shell — it is often rolled into a larger integrated course block like:
- `Spring 2026: Dosage Dsgn, Deliv, Dispens II` (PHAR1010_11111)
- `Spring 2026: Integrated Pharmacotherapy 3` (PHAR1016_22222)
- `Spring 2026: Pharmacokinetics & Dose Opt` (PHAR1002_33333)

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

**"Current Courses" may not show everything.** Some schools group summer courses under
the previous term (e.g. "Spring 2026"). Always check multiple terms:
1. **Current Courses** — usually shows compliance training, practice-experience shells, open courses
2. **The previous term** — a likely location for summer course shells (may show "Closed" but content may still be accessible)
3. **Upcoming Courses** — next term's locked shells
4. **All Terms** — fallback; search by the program's course-code prefix (e.g. `"PHAR"`) to filter long lists

**When graph courses don't match any Blackboard shell name** after checking all terms, flag it in the sync report and ask the student for the mapping — they may know the Blackboard course code (e.g. `PHAR1016_22222`) that differs from the curriculum number.

## Institution Page (notices/announcements)
URL: `https://blackboard.<school-domain>/ultra/institution`  
Contains IT/help announcements from the school:
- System issues (syllabus tools, browser document errors, Blackboard mobile app)
- Resource links (care team, telehealth, library, disability services, etc.)
- Usually generic and rarely time-sensitive — check for new headings but don't expect changes every session.

## Daily brief workflow
After scanning courses + Institution Page:
1. Save note to `~/Documents/Nemesis Library/School/Daily brief — Blackboard YYYY-MM-DD.md`
2. Check the school email separately (not auto-logged-in from the Blackboard session — sign-in is independent)
3. End with a read-only disclaimer: nothing submitted or changed

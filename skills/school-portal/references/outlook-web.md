# Outlook web — navigation reference

## Logged-in detection

Outlook web loads as a single-page app. `browser_snapshot` may return "(empty page)"
even when the user IS logged in. To verify:

```
browser_console(expression: "document.title")
```

Expected result: `"Mail - Doe, Jane - Outlook"` (or similar `<Name> - Outlook`).
If the title contains "Outlook" and a name, the session is live.

## Inbox structure

The inbox is an `aria-role="listbox"` with sections:

```
Pinned  (older emails kept at top)
━━━━━━━
Today
━━━━━━━
Yesterday
━━━━━━━
This week
━━━━━━━
Older
```

Each email is an `aria-role="option"` inside the listbox. You can extract all visible
emails with:

```
browser_console(expression: "Array.from(document.querySelectorAll('[role=\"option\"]')).map(o => o.textContent?.trim()?.substring(0, 300))")
```

## Opening an email (reading pane)

**Key pitfall:** clicking a conversation header toggles expand/collapse — it does NOT
open the reading pane. To see the email body:

1. Click the **"Expand conversation"** button (a small chevron inside the option row)
2. This reveals sub-messages as `aria-role="listitem"` elements
3. Click one of those sub-messages → the reading pane opens on the right

The reading pane shows:
- From / To / Cc / Date headers
- The email body in a `role="document"` region
- Toolbar: Reactions, More items, Close, Previous/Next navigation
- A "Summarize this email" button (Copilot integration)

To close the reading pane and return to the list: click the **Close** button in the
pane header.

### Cycling through messages with Previous/Next

The reading pane header has **"Open the previous item"** and **"Open the next item"**
buttons (left and right chevrons). These cycle through ALL messages in the current
inbox view in date order — they are NOT limited to a single conversation thread.

Use this when:
- A conversation thread has multiple replies and you want to see each one
  individually (the summarized conversation view may only show the latest)
- You need to rapidly scan several emails without returning to the list between each

**Behavior:** clicking "Open the next item" advances to the next email in the
chronological sequence of the inbox. It works across sections (Pinned → Last week →
Older). When you reach the newest email and click Next again, it wraps to the next
inbox section.

## Conversations vs individual messages

Outlook groups related emails into **conversations** (visible as email threads).
A conversation header shows "Collapsed" or "Expanded" state. Individual messages
inside a conversation have their own sender, date, and body.

The "Select a conversation" checkbox affects ALL messages in the thread. Be careful
not to mass-select.

## Attachments

Outlook web attachments are rendered dynamically — they are served through
OneDrive/SharePoint as signed URLs and are NOT present in the DOM as static
download links. **You cannot auto-download them via browser automation tools.**

If a student asks for a file from an email, tell them to:
1. Open that email manually in their own browser
2. Click the attachment link (paperclip icon) to download

## Search as fallback for buried emails

When pinned emails are not visible in the default inbox view (conversation grouping
may subsume them, or the list paginates them away), use the search box:

1. Click the search combobox (near the top of the page)
2. `browser_type` a distinctive part of the subject or sender name
3. `browser_press` Enter
4. Snapshot the search results — they include items from all time ranges

Search results also show the **"Has attachments"** badge when applicable, making
it easier to spot emails with files.

## SPA session state after cross-origin navigation

If the browser navigates to a completely different site (e.g., PubMed, Google) and
then returns to Outlook, the SPA may lose its message-list rendering state even
though the user is still authenticated. Symptoms:

- Title shows `"Mail - <Name> - Outlook"` — session is live
- Navigation pane and ribbon render
- But the message list shows only an empty generic container

The session has NOT expired — the SPA's internal state was corrupted. Fix:

- Navigate to `outlook.cloud.microsoft/mail/` fresh and wait for re-render
- If it stays empty, ask the student to visit Outlook once in their own browser
  to restore the session token

## Reading the full email body

The email body is inside `[role="document"]` element. Get it with:

```
browser_console(expression: "document.querySelector('[role=\"document\"]')?.textContent?.trim()")
```

If the email is long, you may need to scroll the reading pane first using
`browser_scroll(direction: "down")` before all content is loaded into the DOM.

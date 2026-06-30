# Jules Supervisor — UI/UX Analysis & Suggestions

## What's Good ✅
- Dark glassmorphism aesthetic is solid and cohesive
- Animated background blobs give depth
- Colour-coded status badges are clear and consistent
- Timeline execution graph is a great visual metaphor
- Pulsing dots on active tasks are a nice live-status touch
- The lock screen is clean and professional
- Inter + Outfit font pairing works well

---

## Issues Found & Suggestions

### 🔴 High Priority (Confusing / Broken UX)

#### 1. Phase Selector is too small and hidden
**Problem**: The "Load Phase" dropdown is only 170px wide in the top-right corner. Most phase names are long (e.g. "Fix Official Form Routing Gate...") and get cut off. Users can't tell what phases exist without hovering.  
**Fix**: Widen to 280px minimum, add truncation tooltip, or move to a dedicated "Switch Phase" panel inside the main console area.

#### 2. No visual feedback when phase starts launching
**Problem**: Clicking "Launch Phase" shows no loading state — the button stays active while the server is creating the GitHub branch and Jules sessions (which can take 3-5s). Users may click again thinking it didn't work.  
**Fix**: Disable the button + show a spinner ("Launching...") during the API call.

#### 3. Task detail modal has no action buttons
**Problem**: The new task detail modal shows all info but the action buttons (Retry, Skip, Mark Merged) are still only on the tiny timeline card. Users clicking "View Details" expect to also be able to take action from there.  
**Fix**: Move Retry / Skip / Mark Merged into the modal footer so users can act on what they're reading.

#### 4. Q&A Console screen is separate from execution — users miss it
**Problem**: The Q&A Console is a separate nav tab. When Jules asks a question, there's nothing on the Execution Graph tab that tells the user to go look there. The only hint is the escalation count box.  
**Fix**: When `waiting_answer` status is detected, show a yellow banner on the Execution Graph tab: "Jules is waiting for your input — view Q&A Console" with a direct link.

#### 5. "Save & Prepare Phase Draft" button label is confusing
**Problem**: Users click this expecting something to happen (start the phase). But it just saves a draft. Then they have to find the separate "Launch Phase" button. The two-step flow is unclear.  
**Fix**: Rename to "Save Draft & Continue →" and make the next step (Launch) visually obvious directly below the task list, not hidden at the bottom of the form.

#### 6. No empty state for the Execution Graph
**Problem**: When you load a phase that just started and the timeline is empty or hasn't polled yet, the screen is blank. Users don't know if it's loading or broken.  
**Fix**: Add a skeleton loader or "Polling for tasks..." message while waiting for the first status response.

---

### 🟡 Medium Priority (Friction / Clarity)

#### 7. Phase Progress bar is always 100% until suddenly complete
**Problem**: The progress bar only counts `merged` and `skipped` tasks. A phase with 5 running tasks shows 0% until they all finish. This feels like nothing is happening.  
**Fix**: Show partial credit — e.g. `running` = 50% weight, `pr_open` = 75%, `merged` = 100% for each task.

#### 8. Phase branch name is shown but not clickable
**Problem**: The phase branch (e.g. `feature/fix-form-routing-gate-a3f2k`) is shown in the phase header, but it's plain text. Users have to manually copy it to go look at it on GitHub.  
**Fix**: Make it a hyperlink to `https://github.com/{owner}/{repo}/tree/{branch}`.

#### 9. Poll interval (5 min) is too slow for active sessions
**Problem**: The poller checks Jules every 5 minutes (`300000ms`). If Jules finishes a task and opens a PR, you won't see it for up to 5 minutes.  
**Fix**: When a task is `running` or `waiting_answer`, poll every 30s. When all tasks are `merged`/`queued`, fall back to 5 min. Add a manual "Refresh Now" button.

#### 10. No keyboard shortcuts
**Problem**: Power users have no shortcuts. Every action requires mouse navigation.  
**Fix**: Add `Esc` to close modals (already partially works), `1/2/3` to switch nav tabs, `R` to refresh status.

#### 11. The "Clear & start fresh" link is too subtle
**Problem**: It's tiny grey underlined text — users won't find it when frustrated by stale form data.  
**Fix**: Style it as a small ghost button: `[🗑 Clear form]` with a danger-muted colour.

#### 12. Add Task modal has no dependency preview
**Problem**: When adding a task to an active phase, the dependency checkboxes show raw task titles. There's no indication of which tasks are currently running vs completed.  
**Fix**: Add status badges next to each task in the dependency list inside the Add Task modal.

---

### 🟢 Low Priority (Polish)

#### 13. No favicon
**Problem**: Browser tab just shows default icon.  
**Fix**: Add a simple SVG favicon (the layers icon already in the logo works great).

#### 14. Toast notifications disappear too fast
**Problem**: The "Task marked as skipped" toast is only shown briefly and uses no animation.  
**Fix**: Slide in from bottom-right, stay 3.5s, slide out. Add a colour-coded left border (green for success, red for error).

#### 15. No confirmation on "Launch Phase" for high-risk operations  
**Problem**: Clicking Launch immediately fires against GitHub & Jules with no summary of what will happen.  
**Fix**: Show a 2-second confirmation panel: "This will create branch `feature/...` on `main` and launch 3 Jules sessions. Confirm?"

#### 16. Phase title in active view is not editable
**Problem**: If the user mistyped the phase title, there's no way to fix it after saving the draft.  
**Fix**: Add an inline edit pencil icon next to the phase title in the active phase header.

#### 17. The polling health indicator ("ONLINE / OFFLINE") is ambiguous
**Problem**: "ONLINE" means the poller is running. "OFFLINE" means the phase is done or not started. "COMPLETED" is a third state. Users confuse these.  
**Fix**: Use clearer labels: `⏱ Polling`, `✅ Phase Complete`, `🚫 Not Running`.

---

## Summary Table

| # | Issue | Priority | Effort |
|---|-------|----------|--------|
| 1 | Phase selector too small | 🔴 High | Low |
| 2 | No loading state on launch | 🔴 High | Low |
| 3 | No actions in task detail modal | 🔴 High | Medium |
| 4 | No alert when Jules needs input | 🔴 High | Low |
| 5 | Confusing draft/launch button flow | 🔴 High | Low |
| 6 | Blank execution graph on load | 🔴 High | Low |
| 7 | Progress bar stays 0% too long | 🟡 Medium | Low |
| 8 | Branch not hyperlinked | 🟡 Medium | Low |
| 9 | Polling too slow for active tasks | 🟡 Medium | Medium |
| 10 | No keyboard shortcuts | 🟡 Medium | Medium |
| 11 | "Clear form" link too subtle | 🟡 Medium | Low |
| 12 | Dependency list shows no status | 🟡 Medium | Low |
| 13 | No favicon | 🟢 Low | Low |
| 14 | Toast animation missing | 🟢 Low | Low |
| 15 | No launch confirmation summary | 🟢 Low | Low |
| 16 | Phase title not editable | 🟢 Low | Medium |
| 17 | Ambiguous poller status labels | 🟢 Low | Low |

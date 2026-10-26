# UX audit and improvement plan

Scope: every page for the three roles (worker, supervisor, administrator), reviewed in the running
app and in the shared components. Business logic, permissions, the database and integrations are
out of scope and unchanged. The design identity (warm neutrals, one green accent, Inter) stays.

## What already works well

- One consistent component set (`UiButton`, `UiDialog`, `UiField`, `StateBlock`, `StatusBadge`).
- Every page handles loading, error and empty states through `StateBlock`.
- Role-specific navigation, plus a one-tap bottom bar for workers on phones.
- Dialogs trap focus, close on Escape and return focus.
- Reduced-motion users already get near-zero animation durations.

## Issues, most important first

| # | Issue | Where | Effect on users |
|---|---|---|---|
| 1 | Changing a filter, tab, week or day replaces the whole list with a skeleton, then redraws it | Issues tabs, Report history filters, Schedule weeks, Today's date, Audit filters | The page jumps and flashes on every click; users lose their place |
| 2 | Lists never refresh by themselves | Review queue, Shift takeover, worker Today | A supervisor waiting for a report must reload the page to see it arrive |
| 3 | Pages swap with no transition, and lazy-loaded pages give no sign that anything is happening | All navigation | Clicks feel unresponsive on slower connections |
| 4 | Skeletons appear even for very fast loads and are plain grey bars | All pages | A brief flash on every visit; the placeholder doesn't resemble the content |
| 5 | Dialogs have no close button and appear without motion; on phones the bottom sheet just pops in | All dialogs | Touch users look for a way out; the change of context is abrupt |
| 6 | Buttons give no press feedback; hover changes snap instantly on rows and links | Everywhere | Interactions feel flat rather than responsive |
| 7 | Success and information toasts look identical, and appear with a plain fade | Toasts | Users can't tell at a glance whether something worked |
| 8 | Supervisor navigation is a flat list of seven items with no count on the review queue | Supervisor sidebar and menu | The most important daily task isn't signposted |
| 9 | The phone menu (supervisor, admin) opens instantly, pushes the page down, and stays open on outside taps | Mobile header | Feels unfinished; easy to get stuck |
| 10 | Only the reference code is clickable in report history; user rows only through a small Edit button | Report history, Users | Small targets, inconsistent with the Issues table where the whole row is clickable |
| 11 | Removing listed problems uses the browser's `confirm()` box | Report form | Looks out of place against the app's own dialogs |

## Plan

1. **Keep content on screen while it refreshes** (`useAsync`): a page only shows the skeleton on its
   first load. Later reloads keep the current data, dim it slightly, and swap it in when ready.
   Optional quiet background refresh (interval + when the tab regains focus) for the queue,
   the takeover page and the worker's Today.
2. **Loading feedback**: a thin progress bar at the top during navigation; skeletons that wait
   150 ms before appearing and are shaped like a card list, with a gentle shimmer.
3. **Page transitions**: a short fade-and-rise (about 160 ms) when the page changes.
4. **Dialogs**: a close button, a scale-in on desktop and a slide-up sheet on phones.
5. **Micro-interactions**: press feedback on buttons, smooth hover colour on rows, links and tabs.
6. **Toasts**: a coloured marker per tone and a slide-up entrance.
7. **Navigation**: group the supervisor menu into *Daily work* and *Records*, show the number of
   reports awaiting review, and animate and auto-close the phone menu.
8. **Tables**: whole-row click targets in report history and users, matching Issues.
9. **Report form**: replace `confirm()` with the app's own dialog.

Not doing: new features, new icons, dashboard redesigns, decorative animation, or changes to who can
do what. Every change reuses the existing components and colour tokens.

## Status: implemented

All nine items are in place. Two notes from testing:

- **Page changes use a CSS entrance animation, not a Vue `<Transition>`.** A Vue transition waits
  for the browser's animation frames; in a background tab or a minimised window those are paused,
  and the app looked stuck on the previous page. The CSS animation looks the same but never blocks
  navigation.
- **Dialogs focus the first field, or Cancel when there is no field**, so pressing Enter in a
  confirmation (for example *Reset everything*) never triggers the destructive action.

Checked: typecheck, build, all automated tests; every page for each role opens with no console
warnings; supervisor, admin and worker are still redirected away from pages that are not theirs and
the API still refuses them (403); filters and tabs keep their list on screen; dialogs close with the
button and Escape; whole-row clicks open the right report or user.

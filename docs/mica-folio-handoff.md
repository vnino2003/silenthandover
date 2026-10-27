# Mica Folio: design and logic handoff

The user selected concept **B, Mica Folio**, on 2026-10-28. They subsequently clarified the division of work: the other implementation owns Mica's logic; this implementation owns the mascot, interaction design and frontend integration. This document makes the current integration contract concrete. No other chat was messaged: its identity was not available in the app's task list.

## Design delivered

- `MicaMascot.vue`: independently articulated SVG pages, face, eyelids, brows and hands, adapted from the selected folio character. Muted teal and ivory, modest eyes and a quiet expression. The SVG is deliberately simpler than the textured illustration at launcher sizes.
- `public/assistant/mica-folio.png`: refined transparent illustration made with built-in image_gen. Original prompt and provenance are alongside it. The old bird asset is retained for history and has no remaining UI references.
- `AssistantDock.vue`: one contextual entry surface, no initial Help/Prepare tab requirement; at most three role/page suggestions, quiet response history, readable answers, a fixed help composer, and a focused preparation view.
- `stores/mica.ts`: one in-memory session for the floating and expanded workspace, unsent input preservation, source-page context during expansion, interruption of informational requests, and session clearing on account changes. No conversation is stored in browser persistent storage.
- `AssistantWorkbench.vue`: shares preparation state with the dock, keeps the existing edit/review/confirm path, and displays the normal-form handoff. Delayed callbacks are guarded against account changes.
- `router.ts` / `lib/mica-context.ts`: explicit page contexts and role-appropriate suggestions, including employee schedules and all leave pages.
- `useDictation.ts`: distinguishes microphone startup, confirmed listening and final transcription. Stopping, hiding the document and unmounting cancel or finish actual recognition appropriately. There is no simulated waveform or speech playback.
- Reduced motion disables character transforms and animation. Background tabs pause decorative movement. Keyboard focus returns to the launcher on closing; replies have a concise screen-reader announcement. Ctrl/Cmd+Enter sends typed questions; normal Enter remains a newline.

## Interface contract for the logic owner

`POST /api/assistant/help` accepts `{message, page, entity_id?}`. `page` comes from route metadata; the server must enforce role/entity authorization again. It returns the shared, runtime-validated `MicaAnswer`:

```ts
{
  page, reply, engine, fallback,
  facts: [{ title, items: [{ label, value, tone?, link? }], empty? }],
  notices: string[],
  checked_at: string,
  leave_draft?: { start_date: string, end_date: string }
}
```

The UI renders facts separately from generated guidance. Links must be authorized local application paths; model output must never supply executable links or actions. `engine: records` means an application-generated response from records; `engine: guide` means static workflow guidance. `fallback: true` communicates unavailable/invalid AI without discarding the input or the available facts. Proposed leave dates are shown separately from recorded facts.

The preparation endpoints retain their existing id/version state and confirmation semantics. The frontend accepts `AssistantView.notices` and optional `leave` state. The draft handoff uses `POST /api/assistant/preparations/:id/draft` with `{version}` and an exactly-once `result.kind: draft` receipt, then opens the ordinary report form. A draft receipt must never be presented as a submitted report. The matching SQL migration uses the existing draft function and protects newer manual edits with the preparation's original report snapshot.

The Leave form handoff is deliberately in-memory: dates only, never a private reason. The existing form selects the leave type, collects the reason, validates and submits. Asking Mica creates no leave request.

The displayed character states are `ready`, `attentive`, `requesting`, `listening`, `transcribing`, `processing`, `response`, `recorded` and `unavailable`. `recorded` is entered only after a server receipt. `processing` means a real pending application request, not a claim that a model is streaming. A future speaking state should be tied to real speech start/end/error events.

## Overlapping backend work and data boundary

While implementing the originally approved full plan, overlapping logic changes appeared in shared schemas, `mica-facts.ts`, `mica.ts`, prompt helpers and the assistant routes. Those changes were inspected and preserved rather than reset. The current working tree also contains supporting fixes made here: the employee schedule return/type contract, normal-form draft handoff, name restoration, guided preparation fallback, local leave-date extraction and the typed Help response. The logic owner should review these files together before further edits; there should be one implementation of each endpoint, not parallel handlers.

**Automatic approval review rejected adding live schedule, leave, report and operational facts to external model requests because the new payload was not specifically authorized for a destination.** The active Help route therefore keeps those facts inside Silent Handover, uses application-generated record answers, and sends only the existing sanitized question/configuration/guide material for AI guidance. The fact-summarizing helper from the overlapping backend implementation is not wired to Help. Tests assert that record questions and leave preparation generate no outbound provider call.

A later decision to send any of these additional facts externally requires resolving that approval boundary with the specific data and configured provider. The design does not depend on doing so. Conversation history currently stays in the UI; richer model follow-up context is for the logic owner to implement under the same privacy boundary.

## Verification

- Full regression run passed: 8 shared and 169 server tests (177 total). The finalized 6 frontend-session tests also passed separately, adding same-account role/department isolation coverage to the earlier suite.
- Shared, server and web typechecks passed; server and web production builds passed. Final frontend refinements are checked again before delivery.
- Browser checks used the actual employee, supervisor and administrator demo roles. Checked contextual suggestions, authorized record presentation, expanded/minimized continuity, unsent text, Escape focus return, leave-date handoff, provider-error fallback and interruption. No report, leave, approval or schedule decision was submitted in the live demo.
- Mobile checks at 320 and 390 pixels showed no horizontal document overflow. Desktop checked at 1440 pixels. The composer remained usable and the panel cleared mobile navigation.
- Microphone lifecycle is covered by browser-event fixtures, not a physical recording. Text-to-speech, physical-device frame rate, real soft-keyboard geometry and OS-level reduced-motion emulation were not tested. Reduced-motion rules were inspected in the loaded stylesheet. A successful live-model reply was not verified; the provider returned an error during guidance testing.
- Visual evidence is in `outputs/mica-folio/`.

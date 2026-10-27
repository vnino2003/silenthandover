# Mica motion

Mica keeps the existing artwork, panel dimensions, navigation, and preparation flow. Motion is shared by the floating assistant and full assistant workspace.

- Welcome: a single 650 ms greeting tilt with a small settling bounce.
- Idle: a 7 second float, limited to 1.5 px and 1 degree; small conversation avatars remain still.
- Blink: a brief eyelid overlay every 8.7 seconds, with size-based offsets so adjacent mascots do not blink together. The original transparent PNG is unchanged.
- Working: a gentle 2.4 second thinking tilt, with readable status text rather than opacity pulsing.
- Listening: a restrained attentive tilt and composer outline while dictation is active.
- Recorded: one small nod after the server returns a successful result.
- Interaction: launcher hover/focus greeting, short press feedback, a 280 ms panel entrance, a 160 ms exit, and 240 ms message/context entrances. No automatic scrolling or character-by-character text animation.

The panel stays mounted when closed, preserving preparation state, typed text, and selected mode. Escape and the close button return keyboard focus to the launcher after Vue updates its visibility. No submission or approval behavior changes.

Animations use CSS transforms and opacity, without timers, animation libraries, or additional raster assets. Decorative mascot animations pause when the document is hidden or the dock is behind a modal. Hidden panel content does not animate on screen. `prefers-reduced-motion: reduce` disables Mica's decorative animations, movement on hover/press, and panel transforms/transitions; status text and all controls remain available.

## Verification

- Web production build, including Vue/TypeScript checking, passed.
- Actual local app checked at 1440 × 900, 390 × 844, and 320 × 740. Both phone widths had matching document/client widths with no horizontal overflow; the panel remained inside the viewport above navigation.
- Checked open, close, Escape focus return, Help/Prepare switching, preserved unsent composer text across close/reopen, working animation, and provider error recovery.
- Inspected the browser's loaded reduced-motion stylesheet rules. OS-level reduced-motion emulation, physical-device frame rate, actual microphone dictation, and successful live-provider replies were not tested. The configured provider was unreachable during the help request; no records were submitted.
- Desktop visual evidence: `outputs/mica-motion/desktop.png`.

CSS motion definitions are in `apps/web/src/style.css`; avatar states and eyelids are in `apps/web/src/components/MicaMascot.vue`.

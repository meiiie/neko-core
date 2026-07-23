# Mobile — responsive first, native only if the demo needs it

When the product is used on a phone (Archetype E and many consumer/AI apps). At a hackathon, **a
polished responsive web app beats a half-built native app** almost every time — no store review, one
codebase, instant demo on the judge's phone via a URL/QR.

## Default: responsive web (or PWA)
- **Mobile-first layout.** Design the small screen first, then widen. One-column, thumb-reachable
  primary actions (bottom or within easy reach), generous tap targets **>=44px** (Apple HIG).
- **Real breakpoints, fluid type.** `clamp()` for type/spacing; test at 360px, 768px, 1200px. No
  horizontal scroll ever (wide content gets its own `overflow-x:auto`).
- **Touch, not hover.** Don't hide anything behind hover; give tap/press states; avoid tiny close-buttons.
- **Inputs that don't fight the user.** 16px input text (prevents iOS zoom), correct `inputmode`/
  `type`/`autocomplete`, labels above fields, visible focus.
- **PWA if it earns it:** a manifest + icon + service worker makes it installable and feel app-like, and
  demos "as an app" without a store. Add offline only if the task needs it.
- **Performance is UX on mobile:** ship minimal JS, lazy-load images, target fast INP/LCP (see `seo.md`).
  A janky phone demo reads as broken.

## Native / cross-platform (only when the task requires device APIs)
Reach for React Native / Expo (fastest to a running app on a real phone), Flutter, or a thin native
shell ONLY when you genuinely need camera, sensors, push, background, or app-store presence for the demo.
- **Expo** is the hackathon pick: `expo start` + Expo Go runs on the judge's phone over QR in minutes,
  no Xcode/Android Studio setup.
- Scope to ONE screen flow done well; native breadth is a time sink that rarely scores.

## Demo-proofing (mobile-specific)
- **Have a QR to the URL/build** ready so judges try it on their own phone in seconds — a strong wow.
- Test on a **real device**, not just the desktop responsive emulator; touch, keyboard, and safe-areas
  (notch) behave differently.
- Respect safe areas (`env(safe-area-inset-*)`), test both orientations if relevant.
- A recorded fallback (see `devops.md`) — phone demos are the most fragile live.

## Skip (ponytail)
Native for both platforms from scratch, app-store submission, deep-linking, complex offline sync,
push infra — none is scored in 48 hours. Responsive web + a QR is the highest ratio of impact to time.

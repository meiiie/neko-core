# Motion engine — animation that reads as elite, not gimmicky

Motion is the single biggest thing separating a clean page from an award-winning one — and the fastest
way to make a page feel cheap if done wrong. The rule: **every animation must have a purpose** (inform,
guide attention, give feedback, or tell a story). If it has none, delete it. Read this before adding any
motion; then add the least that achieves the intent.

## The three attributes of every motion
Every animation is `duration × easing × property`. Get these right and it feels natural; get them wrong
and it feels robotic.

- **Property**: animate cheap, compositor-friendly properties — `transform` (translate/scale/rotate) and
  `opacity`. AVOID animating `width/height/top/left/margin` (they trigger layout = jank). `filter` and
  `clip-path` are OK in moderation.
- **Duration** (scale to distance/size; small = fast):
  - Micro (hover, button press, toggle): **100-200ms**.
  - Standard (cards, dropdowns, reveals): **200-400ms**.
  - Large (full-screen, page transitions): **400-600ms**. Rarely over 600ms — long = sluggish.
- **Easing** (this is what "natural" means):
  - **Entering** the screen → `ease-out` (fast in, gentle stop). e.g. `cubic-bezier(.16,1,.3,1)`.
  - **Exiting** → `ease-in` (gentle start, accelerate away).
  - **Moving between states** of the same element → `ease-in-out`.
  - Asymmetric accel/decel feels more natural than symmetric. **Never `linear`** for UI motion (only for
    continuous things like a marquee or a scroll-scrubbed timeline).

## Micro-interactions (do these first — cheap, high polish)
Essential set, nothing more: **hover** (subtle lift/color, 150ms), **press/active** (scale ~0.98),
**focus** (visible ring — accessibility, not optional), **state feedback** (success/error transitions),
**enter transitions** (content fades/slides up ~16-24px on mount). A button with a considered hover +
active + focus already reads 10x more finished than a static one. Do not animate everything — restraint
IS the polish (Apple's "Deference").

## Scroll-driven storytelling (the elite layer)
This is where award sites live: animation tied to scroll position so the page unfolds as a narrative.

**Native first (CSP-safe, no library — prefer this for artifacts/simple sites):**
- `animation-timeline: scroll()` — link an animation to the scroll progress of a container.
- `animation-timeline: view()` + `animation-range: entry 0% cover 40%` — trigger as an element enters
  the viewport (the native equivalent of a reveal-on-scroll). Great for section reveals, parallax.
- Combine with `@supports (animation-timeline: scroll())` and a sensible static fallback.

**GSAP + ScrollTrigger (when you need orchestration, pinning, or fine control — real projects):**
- **Scrub vs discrete**: `scrub: true` ties the animation 1:1 to scroll (scrubbing); `toggleActions`
  plays it once on entry. **Do not use both on the same trigger.**
- **Pin** a section (`pin: true`) to hold it while inner content animates — the basis of split-screen
  mask reveals and "cinematic" sequences. Pinning adds a spacer; account for layout.
- **Fake horizontal scroll**: animate `xPercent` with `ease: "none"` for 1:1 mapping.
- **Performance**: `ScrollTrigger.batch()` for many similar elements; `matchMedia()` for
  responsive/disable-on-mobile; create triggers top-to-bottom; call `ScrollTrigger.refresh()` after
  layout changes; **kill()** instances on unmount (SPA/React); remove `markers:true` before shipping.

**Signature patterns worth one each (not all) per page:** parallax depth (bg/fg at different speeds),
pinned mask/clip reveal, staggered list entrance, a number/counter that animates up, a hero element that
responds to scroll or pointer. Pick ONE hero motion moment and make it excellent.

## The top-tier ceiling (use only if it earns the score)
- **WebGL / 3D** (Three.js, OGL) or **Rive** (interactive vector motion) power SOTY-level heroes (e.g. a
  rotating 3D object, a shader background). High effort/risk — only when the site *is* the product and
  time allows. A great CSS/scroll page beats a broken WebGL one every time.
- **View Transitions API** for smooth same-document and cross-document page transitions (native, 2026).

## Accessibility & performance (non-negotiable)
- **Always** honor `@media (prefers-reduced-motion: reduce)` — disable non-essential motion, keep
  opacity fades at most. Motion sickness is real; judges and users notice.
- Keep it 60fps: transform/opacity only, `will-change` sparingly, no animating layout properties.
- Don't block content on animation — the page must be usable if JS/motion fails. Never hide critical
  content behind a scroll animation that might not fire.
- Test on a mid-range device, not just your machine.

## Do / Don't
- DO: purposeful, fast, transform/opacity, ease-out on entry, one signature moment, reduced-motion fallback.
- DON'T: animate everything, `linear` UI easing, >600ms durations, layout-triggering properties,
  gratuitous fade-in-on-scroll on every element, motion with no informational purpose, blocking content.

## Learn more
GreenSock GSAP + ScrollTrigger docs; Codrops (tympanus.net) for scroll technique tutorials; MDN
`scroll-timeline`/`view-timeline` and the View Transitions API; Material/Figma motion foundations for
easing + duration theory.

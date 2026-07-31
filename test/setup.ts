import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000); // subprocess/UI polls have their own bounds; avoid Bun's 5s wall-clock preemption under CI load

/** Test preload (bunfig.toml). BELT ONLY - do not rely on its env mutation: bun >=1.3.14 can run test files in
 * workers where this preload's env mutation is NOT reliably visible (observed on GitHub runners AND
 * locally: NEKO_FULLSCREEN was undefined mid-suite, so inline tests mounted fullscreen). Every ChatApp
 * test therefore passes the mode EXPLICITLY (fullscreen={false} inline, cloneElement(...{fullscreen:
 * true}) in the fullscreen helpers); this baseline only covers stray non-ChatApp config reads. */
process.env.NEKO_FULLSCREEN ??= "0";

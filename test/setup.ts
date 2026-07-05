/** Test preload (bunfig.toml). BELT ONLY - do not rely on it: bun >=1.3.14 can run test files in
 * workers where this preload's env mutation is NOT reliably visible (observed on GitHub runners AND
 * locally: NEKO_FULLSCREEN was undefined mid-suite, so inline tests mounted fullscreen). Every ChatApp
 * test therefore passes the mode EXPLICITLY (fullscreen={false} inline, cloneElement(...{fullscreen:
 * true}) in the fullscreen helpers); this baseline only covers stray non-ChatApp config reads. */
process.env.NEKO_FULLSCREEN ??= "0";

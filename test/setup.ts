/** Test preload (bunfig.toml): the suite's baseline is INLINE mode - fullscreen is the product default,
 * so pin the env here instead of editing every rendering test. Fullscreen tests set "1" per-test. */
process.env.NEKO_FULLSCREEN ??= "0";

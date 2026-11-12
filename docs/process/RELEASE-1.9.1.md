# 1.9.1 release preparation

This record contains only technical release evidence; existing WORKLOG history
is unchanged.

- Browser PR #95: dedicated managed profile, explicit personal consent mode,
  extension fallback and snapshot label privacy. Cross-platform CI passed;
  Windows cleanup EBUSY in the first run did not recur on the one retry.
- Windows managed backend: multi-tab lifecycle and dedicated-profile persistence
  passed. Neko wrapper: 10 operations passed with the generated pinned backend.
- Personal Chrome grant/deny/revoke remains unverified; do not claim otherwise.
- Dream PR #96: automatic bounded post-turn consolidation, manual/off controls,
  session-scoped notes and fail-closed runtime authority checks.
- Candidate version and site fallback updated together. Source changes do not
  establish a Cloudflare deployment.
- Publication is gated on exact-candidate CI, final build/input/lifecycle probes,
  secret scan, and verification of all 17 release assets, including extension
  sidepanel files. This document does not assert those pending gates passed.

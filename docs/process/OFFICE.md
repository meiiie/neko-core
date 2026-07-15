# Verified Office artifacts

Neko Core can create, inspect, edit, validate, and render `.docx`, `.xlsx`, and `.pptx` files through a
typed adapter. The document engine is optional and replaceable; Office behavior does not enter the agent core.

## Product contract

The user asks for an artifact, not a successful process exit. Neko therefore separates three concerns:

```text
agent + permission mode
        |
        v
McpTools port -> Neko Office adapter -> optional OfficeCLI executable
                       |
                       +-> staged artifact -> validation -> atomic publish
                       +-> targeted readback -> render -> vision review
```

The first-class surface is deliberately small:

| Tool | Permission | Purpose |
|---|---|---|
| `mcp__neko_office__inspect` | safe | status, help, structure, text, issues, targeted get/query, schema validation |
| `mcp__neko_office__apply` | gated | one bounded typed batch against a new or copied artifact |
| `mcp__neko_office__render` | gated | PNG or standalone HTML evidence inside the workspace |

Raw OOXML, plugins, watch servers, arbitrary command strings, remote resources, and macro-enabled mutation
are not exposed. A task that truly needs one of those capabilities must use a separately approved fallback and
state the reduced assurance explicitly.

## Clean-room reference

The design was informed by the public Apache-2.0 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) project.
The untracked reference clone is pinned at source commit `4ba79f0b984e` / release `v1.0.136`; no implementation
code was copied. Neko adopted the useful protocol ideas - typed paths, discoverable help, batch operations,
fresh reads, validation, and visual rendering - behind its own ports, permissions, lifecycle, and tests.

OfficeCLI also exposes broader resident, raw, plugin, and network surfaces. Neko intentionally excludes them
from the normal path. This keeps the dependency optional and prevents a document helper from becoming an
implicit shell or network authority.

## Installation and ownership

Nothing is downloaded during startup or a normal model turn. The user opts in from `/support office` or:

```bash
neko support office status
neko support office install
neko support office update
neko support office remove
```

For a Neko-managed install, the adapter:

1. reads the latest stable release from the official `iOfficeAI/OfficeCLI` GitHub API;
2. accepts only the exact platform asset at the expected official HTTPS path, with a published SHA-256 and a
   bounded size;
3. streams it into a private staging directory and verifies byte count plus SHA-256;
4. checks the platform executable header, exact version, and a real create/validate protocol probe;
5. writes an owner manifest, then atomically swaps the complete support-pack directory;
6. re-hashes the managed executable before its first Office tool execution in every Neko process.

The executable runs without administrator access. Neko disables its self-update, auto-install, and implicit
resident behavior, so one lifecycle remains authoritative. A compatible `officecli` already on `PATH` is reused
and labelled user-owned; Neko never deletes or upgrades that installation. Removing the managed pack never
touches user documents.

GitHub asset metadata plus a digest proves that the bytes match the official release asset. It is not a claim of
publisher code signing or a security audit of the third-party project. It detects download corruption and a
binary-only local modification; an attacker who already controls the user's account could rewrite both the
binary and its local manifest, which is outside this support pack's trust boundary.

## Mutation transaction

All file and embedded-resource paths are bounded to the project root after symlink resolution. The adapter
accepts 1-500 typed `add`, `set`, `remove`, `move`, or `swap` operations and caps the command payload.

Read operations copy the current on-disk bytes into a private temporary snapshot before invoking the engine.
That prevents a separately opened OfficeCLI resident from substituting unflushed in-memory state while Neko
reports the SHA-256 of another disk version. Rendering uses the same snapshot rule. Snapshots are removed after
each call; the returned digest belongs to the exact bytes that were inspected.

```text
inspect source + retain SHA-256
          |
copy/create adjacent hidden stage
          |
single batch --stop-on-error
          |
close -> validate -> non-empty check -> SHA-256
          |
atomic replace (rollback backup on failure)
          |
fresh targeted inspect -> render -> vision review
```

Existing sources are preserved by default. Replacing an existing output needs `overwrite=true`; editing a file
in place additionally needs the SHA-256 from a fresh inspection. A stale precondition fails before mutation.
Temporary command files and failed stages are removed, while the last good output remains intact.

The agent harness treats namespaced `apply` and `render` calls as real state changes. It will not accept a final
answer until a later successful inspection supplies fresh evidence. This is a minimum exit gate, not a semantic
proof: the Office skill still requires readback of every requested target and visual inspection when layout
matters.

## Evidence ladder

Completion claims should name the evidence actually collected:

1. **Protocol** - the engine ran and returned structured output.
2. **Package** - the saved file exists, is non-empty, and passes Open XML validation.
3. **Semantic** - a fresh process reads the exact changed cells, paragraphs, shapes, formulas, counts, and
   invariants requested by the user.
4. **Visual** - every affected Word page or PowerPoint slide, and representative workbook views, are rendered
   and reviewed for clipping, overlap, contrast, typography, and overflow.
5. **Calculation** - formula-heavy workbooks are recalculated in an independent spreadsheet engine before
   numerical results are asserted.

The distinction matters. Microsoft's own [Open XML SDK design notes](https://learn.microsoft.com/en-us/office/open-xml/open-xml-sdk-design-considerations)
state that manipulating a package does not guarantee application validity, layout, recalculation, or external
data refresh.

## Research basis and measured gaps

- [SpreadsheetBench 2](https://arxiv.org/abs/2606.29955) reports only 34.89% for its strongest foundation
  scaffold across 321 workflow-level tasks; insufficient inspection and wrong target selection dominate many
  failures. Neko therefore uses targeted structural discovery before mutation and targeted readback afterward.
- [SpreadsheetAgent](https://arxiv.org/abs/2604.12282) supports structural sketches, localized task-driven
  inspection, and targeted verification rather than dumping entire workbooks into context. The adapter exposes
  bounded outline/get/query operations for the same reason.
- [PPT-Eval](https://arxiv.org/abs/2606.31154) reports a large gap to humans and explicitly penalizes unnecessary
  edits and weak aesthetics. Neko stages a derivative, limits the mutation surface, and keeps semantic and visual
  evidence separate.
- [WindowsWorld](https://arxiv.org/abs/2604.27776) shows that multi-application desktop workflows remain both
  low-success and inefficient. Structured artifact operations are therefore preferred over coordinate-driven
  Office GUI automation; computer use remains the fallback for features that require the native app.

These findings define engineering gates, not a marketing claim that Neko has surpassed an external benchmark.
Benchmark parity requires running the published tasks under comparable models, budgets, and scoring.

## Value evaluation

The opt-in networked evaluation downloads the current official support pack into an isolated temporary home,
then drives the exact Neko adapter:

```bash
rtk bun run eval:office
```

On Windows x64 with OfficeCLI v1.0.136, the evaluation created, reopened, validated, and rendered Word, Excel,
and PowerPoint artifacts. A first PowerPoint attempt was schema-valid but rendered a black inherited title on a
dark navy background; the vision review caught it, and the corrected artifact used an explicit white title.
This is the concrete reason the visual gate is mandatory. Repeated Windows runs took roughly 40-105 seconds for
all three renders, so rendering remains a bounded high-latency evidence step rather than an operation to repeat
blindly.

## Known limits

- Open XML validation does not prove intended content, visual quality, accessibility, or current formula values.
- OfficeCLI rendering is a headless approximation, not Microsoft Office's layout engine.
- `.docm`, `.xlsm`, and `.pptm` are preserved but not rewritten by the typed adapter.
- Complex formulas, external links, pivot caches, macros, fonts, and native-only features need independent checks.
- The support pack is a third-party optional component. Without it, Neko remains fully usable for coding, MCP,
  browser, web, and computer-use work and explains the missing Office capability without silently installing it.

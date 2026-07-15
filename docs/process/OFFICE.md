# Verified Office artifacts

Neko Core can create, inspect, edit, validate, and render `.docx`, `.xlsx`, and `.pptx` files through a
typed adapter. The document engine is optional and replaceable; Office behavior does not enter the agent core.

## Product contract

The user asks for an artifact, not a successful process exit. Neko therefore separates three concerns:

```text
agent + permission mode
        |
        v
McpTools port -> Neko Office adapter -> optional OfficeCLI typed engine
                       |                    -> staged artifact -> validate -> atomic publish
                       |                    -> targeted readback -> PNG/HTML
                       |
                       +-> installed LibreOffice -> private profile -> whole-file PDF evidence
```

The first-class surface is deliberately small:

| Tool | Permission | Purpose |
|---|---|---|
| `mcp__neko_office__inspect` | safe | status, help, structure, text, issues, targeted get/query, schema validation |
| `mcp__neko_office__apply` | gated | one bounded typed batch against a new or copied artifact |
| `mcp__neko_office__render` | gated | PNG/HTML through the typed engine, or whole-file PDF through installed LibreOffice |

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

## Why LibreOffice is a verifier, not the typed editor

LibreOffice is a mature independent implementation, but `soffice --headless` is not a granular document-editing
protocol. Its documented CLI surface primarily opens, prints, and converts files. Full structural automation is
the [UNO component model](https://api.libreoffice.org/), with language bindings, document models, controllers,
frames, services, and a suite lifecycle. Replacing five bounded Neko operations with an ad-hoc UNO bridge would
add a second large object model and make target selection harder to verify.

Neko therefore uses both engines for different claims:

| Capability | Primary engine | What success proves |
|---|---|---|
| targeted inspect/get/query | OfficeCLI adapter | exact package structure was read from a snapshot |
| typed add/set/remove/move/swap | OfficeCLI adapter | a bounded batch validated and published atomically |
| PNG/HTML preview | OfficeCLI adapter | the typed engine produced inspectable visual evidence |
| PDF cross-render | installed LibreOffice | an independent suite opened and laid out the complete saved package |

The LibreOffice runner passes a unique `-env:UserInstallation=file:///...` profile for every call, as required by
the [official command-line documentation](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
It also uses `--headless`, a private output directory, an on-disk source snapshot, a bounded timeout, non-empty
output checks, and atomic publication. The profile and snapshot are removed afterward. This prevents accidental
attachment to the user's running LibreOffice process and avoids user-profile locks or state contamination.

Profile isolation is not an operating-system sandbox. A hostile document can still exercise LibreOffice's file
parser, installed fonts, and system-wide components. Neko therefore limits this adapter to non-macro
`.docx`/`.xlsx`/`.pptx`, never follows embedded links as part of verification, and describes PDF export as
cross-render evidence rather than a security or semantic proof.

## Installation and ownership

Nothing is downloaded during startup or without consent. On the first natural-language Word, Excel, or
PowerPoint request, the TUI detects missing support before calling the model and offers **Install and continue**
or **Continue without installing**. The request stays editable on cancel; after a verified install Neko resumes
that exact request automatically. The same component remains explicitly manageable from `/support office` or:

```bash
neko support office status
neko support office install
neko support office update
neko support office remove
```

### Routing and consent contract

Setup UX is not delegated to whichever model happens to be active. A high-confidence `match:` signal in the
Office skill is evaluated locally after Unicode/diacritic normalization, so natural Vietnamese such as
`tao ... file Word` takes the same path as English without an extra request, embedding model, network call, or
prompt tokens. The UI checks the named Office capability independently of the single best domain route; a task
that also needs procurement therefore cannot hide Office setup. Once work begins, Neko may load a bounded
shortlist of up to three matching skills rather than forcing a mutually exclusive route.

The overlay implements the three outcomes used by MCP elicitation: accept installs and resumes the saved
request, decline continues once with an available local fallback, and cancel restores the untouched request to
the input. The source and size are visible before consent, and no provider call occurs while the choice is open.
This follows the [MCP elicitation interaction model](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
while keeping the current local adapter independent of MCP protocol-version support.

This layered router is deliberate. Anthropic recommends progressive disclosure of skill metadata and loading
full instructions only when needed ([Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills));
OpenAI's tool search similarly reports lower context cost from on-demand definitions
([GPT-5.4 tool search](https://openai.com/index/introducing-gpt-5-4/)). At much larger catalogs, embedding
shortlisting recovers routing accuracy on under-specified production traffic
([Scaling Enterprise Agent Routing](https://arxiv.org/abs/2606.17519)) and can select 3-5 tools with sub-100ms
retrieval in a smaller MCP study ([Semantic Tool Discovery](https://arxiv.org/abs/2603.20313)). Neko does not
pay that dependency and lifecycle cost at its current catalog size. The upgrade gate is measured: add a local
semantic shortlist behind the same `matchSkills` seam only when a representative routing corpus shows lexical
recall loss or catalog-scale confusion; deterministic safety/setup signals remain authoritative afterward.

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

LibreOffice has a separate ownership boundary. Neko discovers `soffice`/`libreoffice` on `PATH` and standard
Windows, macOS, and Linux locations, probes its version, and uses it only when the user requests a PDF evidence
write. Neko neither installs nor removes the desktop suite. On 15 July 2026 the official Windows x64 LibreOffice
26.2.4 MSI was about 355 MiB, more than ten times the typed support binary, and its installation model differs
across MSI, DMG, DEB, RPM, and system package managers. Silently turning that into a managed dependency would be
a worse onboarding and ownership contract. `/support office status` reports the typed engine and LibreOffice
verifier separately. See the [official download page](https://www.libreoffice.org/download/download-libreoffice/)
for platform packages and current release metadata.

Dedicated CI or a portable administrative extraction can set `NEKO_LIBREOFFICE_PATH` to the exact waitable
executable (`soffice.com` on Windows, `soffice` elsewhere). An invalid explicit path fails closed instead of
silently choosing a different installation. Normal users do not need this override.

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
   and reviewed for clipping, overlap, contrast, typography, and overflow. When LibreOffice is available, its
   whole-file PDF supplies an independent layout implementation; export alone is not review.
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
- [Office Comprehension Benchmark](https://arxiv.org/abs/2607.01245) evaluates both native structure and visual
  evidence across DOCX/XLSX/PPTX, including formulas, charts, headers, notes, and named ranges. That supports
  Neko's dual structural/render evidence rather than flattening an artifact into text.
- [OSWorld 2.0](https://arxiv.org/abs/2606.29537) highlights hidden state and post-action verification as dominant
  long-horizon failure modes. Neko uses fresh process boundaries and saved-file evidence instead of accepting a
  GUI or process-success claim.
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

If LibreOffice is installed, the same evaluation additionally exports all three artifacts through the exact PDF
adapter. Set `NEKO_OFFICE_REQUIRE_LIBREOFFICE=1` to turn absence into a failing release gate on a dedicated
LibreOffice runner; `NEKO_LIBREOFFICE_PATH` can point that runner at an explicit portable executable.

On Windows x64 with OfficeCLI v1.0.136, the evaluation created, reopened, validated, and rendered Word, Excel,
and PowerPoint artifacts. A first PowerPoint attempt was schema-valid but rendered a black inherited title on a
dark navy background; the vision review caught it, and the corrected artifact used an explicit white title.
This is the concrete reason the visual gate is mandatory. Repeated Windows runs took roughly 40-105 seconds for
all three renders, so rendering remains a bounded high-latency evidence step rather than an operation to repeat
blindly.

A clean administrative extraction of the official LibreOffice 26.2.4.2 MSI was then selected through
`NEKO_LIBREOFFICE_PATH` without system installation. The exact Neko adapter cross-rendered the same DOCX, XLSX,
and PPTX to non-empty PDFs (36,230 / 33,189 / 35,963 bytes). Rasterized page review showed legible text, preserved
spacing, and the intended dark-slide contrast in all three. The complete typed + PNG + PDF gate took 82.6 seconds.
The run also caught a Windows lifecycle trap before release: `soffice.exe` detaches and cannot provide a reliable
waitable probe, while `soffice.com` returned version and conversion completion correctly. Windows discovery now
accepts the console executable only, and a regression test fixes that contract.

## Known limits

- Open XML validation does not prove intended content, visual quality, accessibility, or current formula values.
- OfficeCLI and LibreOffice rendering are independent approximations, not Microsoft Office's layout engine.
- LibreOffice PDF export is whole-file in the bounded adapter. Page subsets require a later local PDF operation.
- A successful LibreOffice export does not prove formula caches, external data, links, or native Office features
  are current; numerical claims still need independent calculation readback.
- `.docm`, `.xlsm`, and `.pptm` are preserved but not rewritten by the typed adapter.
- Complex formulas, external links, pivot caches, macros, fonts, and native-only features need independent checks.
- The support pack is a third-party optional component. Without it, Neko remains fully usable for coding, MCP,
  browser, web, and computer-use work and explains the missing Office capability without silently installing it.

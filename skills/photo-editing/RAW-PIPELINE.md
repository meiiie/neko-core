## RAW PIPELINE

Use this block for deterministic, headless RAW development on Windows without admin rights. Knowledge baseline: 2026-07-29.

### Default routing

1. Probe every input with bundled LibRaw `raw-identify`; reject corrupt/unsupported compression modes before rendering.
2. Route sensor RAW (`.ARW`, `.CR3`, Bayer/linear `.DNG`) separately from phone-rendered HEIF/HEIC. HEIF is normally already rendered/tone-mapped; never promise RAW highlight recovery for it.
3. Default renderer: portable RawTherapee 5.13 ZIP + version-matched golden PP3 + a code-generated partial PP3. Runner-up: ART 1.26.7 portable + ARP, especially when a custom HEIC/libheif input plugin is acceptable.
4. Use darktable 5.6 only when its scene-referred modules are specifically required and a version-matched golden XMP/style plus installed Windows binary are available. Do not synthesize darktable history XMP from scratch.
5. Treat LibRaw as probe/decoder/library, not as a complete color-managed editor.

### Recipe contract

- Generate PP3/ARP as text section/key deltas layered after a renderer-generated golden base profile. Preserve the target version's `[Version]`; never guess keys or enums.
- Put settings/cache/config inside the job directory. Never overwrite input. Save input/output SHA-256, tool version, command, recipe, stderr and exit code.
- Highlight recovery may recover real information only when at least one channel or useful neighboring samples are not clipped. If all channels are saturated, label reconstruction as plausible synthesis, not recovered detail.
- Render a 16-bit TIFF master, then decode the output again and verify dimensions, orientation, ICC/metadata and a 100% crop of clipped highlights.

### PowerShell templates

RawTherapee 5.13:

    $env:RT_SETTINGS = "D:\job\state\rt-settings"
    $env:RT_CACHE = "D:\job\state\rt-cache"
    & "D:\tools\RawTherapee-5.13\rawtherapee-cli.exe" -o "D:\job\output" -p "D:\job\profiles\camera-base.pp3" -p "D:\job\profiles\agent-delta.pp3" -Y -t -b16 -a -c "D:\job\input"
    if ($LASTEXITCODE -ne 0) { throw "RawTherapee failed: $LASTEXITCODE" }

ART 1.26.7:

    & "D:\tools\ART-1.26.7\ART-cli.exe" -o "D:\job\output" -p "D:\job\profiles\base.arp" -p "D:\job\profiles\agent-delta.arp" -Y -t -b16 -c "D:\job\input"
    if ($LASTEXITCODE -ne 0) { throw "ART failed: $LASTEXITCODE" }

LibRaw probe/fallback:

    & "D:\tools\LibRaw-0.22.2-Win64\bin\raw-identify.exe" -u -f "D:\job\input\IMG_0001.ARW"
    if ($LASTEXITCODE -ne 0) { throw "Unsupported/corrupt RAW" }
    & "D:\tools\LibRaw-0.22.2-Win64\bin\dcraw_emu.exe" -w -H 2 -6 -T -Z "D:\job\output\IMG_0001.tiff" "D:\job\input\IMG_0001.ARW"
    if ($LASTEXITCODE -ne 0) { throw "LibRaw decode failed: $LASTEXITCODE" }

### Mandatory fixture gate

Before shipping a bundle, test actual files for standard/new Sony ARW modes, standard/burst or dual-pixel CR3, Bayer phone DNG, Apple ProRAW variants, Samsung Expert RAW/DNG 1.7 JPEG-XL, and HEIF 8/10-bit with orientation and ICC. Extension recognition is not proof of correct decode.

Evidence basis (accessed 2026-07-29): RawTherapee 5.13 release and CLI/PP3 docs (https://github.com/RawTherapee/RawTherapee/releases/tag/5.13, https://rawpedia.rawtherapee.com/Command-Line_Options); ART 1.26.7 and custom formats (https://github.com/artraweditor/ART/releases/tag/1.26.7, https://artraweditor.github.io/Customformats); darktable 5.6 camera limits/CLI (https://www.darktable.org/resources/camera-support/, https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/); LibRaw 0.22.2 downloads/samples (https://www.libraw.org/download, https://www.libraw.org/docs/Samples-LibRaw.html).

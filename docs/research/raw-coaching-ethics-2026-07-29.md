# RAW pipeline, capture & posing coach, documentary ethics

- Mốc kiến thức: **2026-07-29**
- Ngày truy cập nguồn: **2026-07-29** (trừ khi ghi khác)
- Phạm vi: Windows headless cho AI agent; coaching lúc chụp kỷ yếu đại học bằng điện thoại; chuẩn đạo đức hậu kỳ ảnh tài liệu.
- Quy ước chứng cứ:
  - `[verified]`: claim cốt lõi đã được kiểm tra bằng ít nhất hai nguồn độc lập.
  - `[supported]`: có một nguồn sơ cấp/uy tín trực tiếp hoặc nhiều nguồn chưa độc lập hoàn toàn.
  - `[inference]`: suy luận kỹ thuật/thực hành từ các nguồn đã nêu.
  - `[open]`: chưa đủ bằng chứng hoặc còn cần thử nghiệm thực máy.
- Nguyên tắc ledger: mỗi claim phải có `Nguồn:` kèm URL, ngày xuất bản/cập nhật nếu nguồn công bố (`n.d.` nếu không), và ngày truy cập.

## Nhật ký cập nhật

- 2026-07-29: tạo khung ba phần trước khi thu thập phát hiện.
- 2026-07-29: checkpoint A1 — xác minh release hiện hành từ GitHub chính thức của bốn dự án.
- 2026-07-29: checkpoint A2/A3 — đối chiếu format, gói portable, sidecar và giới hạn highlight recovery từ manual, release note và mã nguồn/tag hiện hành.
- 2026-07-29: checkpoint B — tổng hợp kịch bản nhóm kỷ yếu từ nguồn chính thức của Hurley/Adler/Bryce; bổ sung capture checklist và mốc SOTA đến ShutterMuse/PhotoFramer/CVPR 2026.
- 2026-07-29: checkpoint C — đối chiếu World Press Photo Contest 2026 với AP Photo rules và AI update 2026-07-23; tách ba policy profile documentary.
- 2026-07-29: checkpoint skill — đóng gói ba khối Markdown dán thẳng được, gồm lệnh RAW, image-gen chỉ cho mannequin/silhouette generic và ethics gate fail-closed.

## A. RAW pipeline headless trên Windows cho AI agent

### A1. Kết luận ngắn

- `[supported]` Snapshot release ở mốc nghiên cứu: **darktable 5.6.0** (phát hành 2026-06-21), **RawTherapee 5.13** (2026-07-26), **ART 1.26.7** (2026-07-13), **LibRaw 0.22.2** (2026-07-16). Đây là release `latest` từ repository chính thức tại thời điểm truy cập; cần đối chiếu thêm trang tải/tài liệu dự án trước khi coi là `[verified]`.
  - Nguồn: darktable GitHub Releases, 2026-06-21, https://github.com/darktable-org/darktable/releases/tag/release-5.6.0 (truy cập 2026-07-29); RawTherapee GitHub Releases, 2026-07-26, https://github.com/RawTherapee/RawTherapee/releases/tag/5.13 (truy cập 2026-07-29); ART GitHub Releases, 2026-07-13, https://github.com/artraweditor/ART/releases/tag/1.26.7 (truy cập 2026-07-29); LibRaw GitHub Releases, 2026-07-16, https://github.com/LibRaw/LibRaw/releases/tag/0.22.2 (truy cập 2026-07-29).

### A2. Ma trận định dạng và năng lực thực tế

| Công cụ | ARW / CR3 / DNG | HEIF/HEIC điện thoại | Sidecar sinh bằng code | Batch/headless | Portable không admin | Đánh giá cho agent |
|---|---|---|---|---|---|---|
| **RawTherapee 5.13** | `[supported]` Danh sách extension ở commit/tag hiện hành có `arw`, `cr3`, `dng`; CR3 có decoder riêng/vendored LibRaw. | `[supported]` Danh sách extension mặc định **không có** `heif/heic`; không nên coi preview HEIF bên trong CR3 là hỗ trợ ảnh HEIF độc lập. | `[verified]` PP3 là text/INI chứa thiết lập; `-p` ghép nhiều profile theo thứ tự và code có thể sinh/patch khóa. | `[verified]` `rawtherapee-cli ... -c`; xử lý file hoặc thư mục, xuất JPEG/TIFF/PNG. | `[verified]` Release 5.13 có ZIP Win64 x86-64/ARM64; RawPedia hướng dẫn unzip và đặt `MultiUser=false` hoặc tách `RT_SETTINGS`/`RT_CACHE`. | **Khuyến nghị chính** cho pipeline Windows headless có profile sinh bằng code. |
| **ART 1.26.7** | `[verified]` Có decoder nội bộ và tùy chọn dùng LibRaw; LibRaw 0.22 công bố hỗ trợ DNG và danh sách camera Sony/Canon hiện đại. | `[supported]` Không phải input built-in được chứng minh; ART có plugin ImageIO chính thức với ví dụ HEIC qua `libheif`, kể cả Python phù hợp Windows. | `[verified]` `.arp` là text cùng cú pháp INI; tài liệu đưa ví dụ tự tạo `[Exposure] HLRecovery=Blend`. | `[supported]` `ART-cli` dùng cú pháp họ RawTherapee; tài liệu dự án có lệnh batch thực tế. | `[verified]` Release chính thức có `ART_1.26.7_Win64_portable.7z` và ARM64 portable. | **Runner-up rất mạnh**; dễ portable, HEIF mở rộng tốt, nhưng bề mặt plugin/dependency lớn hơn RawTherapee. |
| **darktable 5.6.0** | `[supported]` Manual liệt kê `ARW`, `CR3`, `DNG`; raw do RawSpeed đọc. Release 5.6 nêu rõ một số mode Sony ARW mới, Apple ProRAW và DNG 1.7/JPEG-XL còn thiếu. | `[supported]` Source khai báo `libheif` cho HEIF/HEIC/HIF import và 5.6 thêm HEIF export; năng lực input phụ thuộc build. | `[supported]` CLI nhận XMP, nhưng history có tag nhị phân có thể nén, database có thể ghi đè XMP ngoài, và module/version có tính tương thích; nên **không tự viết XMP từ số 0**. | `[verified]` `darktable-cli` là pure console, nhận file/folder/XMP/style; có `--configdir`, `--cachedir`, `--library`. | `[supported]` Trang chính thức chỉ phát hành Windows `.exe`, không có ZIP portable chính thức; có thể cô lập dữ liệu bằng option nhưng triển khai binary no-admin không phải đường được bảo đảm. | Chọn khi cần pipeline scene-referred/module highlight mạnh và chấp nhận chuẩn bị golden XMP/style + cài đặt. |
| **LibRaw 0.22.2** | `[supported]` Trang camera chính thức hỗ trợ DNG và nhiều Sony/Canon; 0.22 có DNG 1.7/JPEG-XL **nếu** build với Adobe DNG SDK. | `[verified]` LibRaw nói đến **trích preview HEIF trong CR3**, không phải bộ giải mã ảnh HEIF/HEIC phổ dụng. | Không có sidecar chỉnh ảnh cấp cao; điều khiển qua struct/API hoặc tham số `dcraw_emu`. | `[verified]` Có samples `raw-identify`, `simple_dcraw`, `dcraw_emu`; thích hợp probe/decode nền. | `[verified]` Trang tải chính thức có `LibRaw-0.22.2-Win64.zip` (MSVC 2022). | Dùng làm **format probe/fallback decoder/library**, không phải pipeline hậu kỳ hoàn chỉnh. |

Nguồn cho ma trận:

- Nguồn: darktable manual “supported file formats”, n.d., https://docs.darktable.org/usermanual/development/en/overview/supported-file-formats/ (truy cập 2026-07-29); darktable 5.6.0 release notes, 2026-06-21, https://www.darktable.org/2026/06/darktable-5.6.0-released/ (truy cập 2026-07-29); darktable source dependency list, cập nhật đến 2026-07, https://github.com/darktable-org/darktable (truy cập 2026-07-29); trang cài đặt chính thức, n.d., https://www.darktable.org/install/ (truy cập 2026-07-29).
- Nguồn: RawTherapee source `rtgui/options.h` tại commit `123b4d7b...`/nhánh hiện hành, 2026-07, https://github.com/RawTherapee/RawTherapee/blob/123b4d7b52a7f023712281a7320b3fa643d8f03f/rtgui/options.h (truy cập 2026-07-29); RawPedia “Command-Line Options”, n.d., https://rawpedia.rawtherapee.com/Command-Line_Options (truy cập 2026-07-29); RawPedia “Making a Portable Installation”, n.d., https://rawpedia.rawtherapee.com/Making_a_Portable_Installation (truy cập 2026-07-29); release assets 5.13, 2026-07-26, https://github.com/RawTherapee/RawTherapee/releases/tag/5.13 (truy cập 2026-07-29).
- Nguồn: ART homepage/status, 2026-07-13, https://artraweditor.github.io/ (truy cập 2026-07-29); ART “Adding Support for Custom Image Formats”, n.d., https://artraweditor.github.io/Customformats (truy cập 2026-07-29); ART “User Commands”, n.d., https://artraweditor.github.io/Usercommands.html (truy cập 2026-07-29); release assets 1.26.7, 2026-07-13, https://github.com/artraweditor/ART/releases/tag/1.26.7 (truy cập 2026-07-29).
- Nguồn: LibRaw supported cameras 0.22, n.d., https://www.libraw.org/supported-cameras (truy cập 2026-07-29); LibRaw 0.22.2 download/changelog, 2026-07-16, https://www.libraw.org/download (truy cập 2026-07-29); LibRaw samples, n.d., https://www.libraw.org/docs/Samples-LibRaw.html (truy cập 2026-07-29).

`[inference]` Xếp hạng theo ràng buộc của nhiệm vụ (Windows headless + portable + code-generated recipe): **RawTherapee > ART > darktable > LibRaw-as-editor**. LibRaw vẫn nên đứng trước tất cả ở bước `identify/probe`, không phải ở bước render cuối.

- Nguồn: tổng hợp các nguồn sơ cấp trong ma trận, truy cập 2026-07-29.

### A3. Highlight recovery, sidecar sinh bằng code, batch, portable

- `[verified]` “Highlight recovery thật” chỉ tồn tại khi còn dữ liệu cảm biến hợp lệ: một/vài kênh chưa clip, hoặc lân cận chưa clip cho phép ước lượng. Khi mọi kênh đã bão hòa, không công cụ nào lấy lại chi tiết thật; darktable gọi kết quả là cách “disguise” vùng clip bằng nội dung plausible, RawTherapee mô tả là “guess”.
  - Nguồn: darktable “highlight reconstruction”, n.d., https://docs.darktable.org/usermanual/4.2/en/module-reference/processing-modules/highlight-reconstruction/ (truy cập 2026-07-29); RawPedia “Exposure”, cập nhật 2026-07-14, https://rawpedia.rawtherapee.com/Exposure (truy cập 2026-07-29).
- `[supported]` darktable có nhiều phương pháp từ clip/LCh/color đến guided laplacians; RawTherapee/ART có luminance, color propagation, inpaint-opposed/CIELab/blend tùy phiên bản. Phương pháp truyền màu/inpaint có thể tạo màu hoặc pattern sai; cần kiểm tra mask clipping và crop 100%, không chấp nhận chỉ vì preview “đẹp”.
  - Nguồn: darktable manual, n.d., https://docs.darktable.org/usermanual/4.2/en/module-reference/processing-modules/highlight-reconstruction/ (truy cập 2026-07-29); RawPedia “Exposure”, cập nhật 2026-07-14, https://rawpedia.rawtherapee.com/Exposure (truy cập 2026-07-29); ART pipeline, n.d., https://artraweditor.github.io/Pipeline.html (truy cập 2026-07-29).
- `[verified]` PP3/ARP là đường sinh recipe bằng code đáng tin nhất: đều là text theo section/key, có thể tạo **partial profile** chỉ ghi các khóa agent muốn đổi rồi layer trên profile nền. Luôn giữ khóa `[Version]` do chính phiên bản đích sinh ra và golden profile theo từng phiên bản; không đoán enum/key mới.
  - Nguồn: RawPedia “Sidecar Files - Processing Profiles”, n.d., https://rawpedia.rawtherapee.com/Sidecar_Files_-_Processing_Profiles (truy cập 2026-07-29); ART Book/Reference, n.d., https://artraweditor.github.io/Book và https://artraweditor.github.io/Reference.html (truy cập 2026-07-29).
- `[inference]` Với darktable, recipe nên được tạo theo quy trình **golden XMP/style do darktable 5.6 sinh → copy/apply → chỉ thay metadata an toàn**, không serialize history/module params thủ công. Lý do: history tag có thể là binary/compressed, database ưu tiên hơn file ngoài, và sidecar mới có thể mất module khi mở bằng bản cũ.
  - Nguồn: darktable “storage”, n.d., https://docs.darktable.org/usermanual/development/en/preferences-settings/storage/ (truy cập 2026-07-29); darktable sidecar, n.d., https://docs.darktable.org/usermanual/development/en/overview/sidecar-files/sidecar/ (truy cập 2026-07-29); compatibility note, cập nhật 2026-07, https://github.com/darktable-org/darktable (truy cập 2026-07-29).
- `[open]` Cần test fixture thực trên đúng binary Windows cho: Apple ProRAW DNG, Samsung Expert RAW DNG/JPEG-XL, Sony ARW mode M/S/HQ, Canon dual-pixel/burst CR3 và HEIF 10-bit. Extension nhận diện không chứng minh decoder/profile màu đúng.
  - Nguồn: darktable camera-support limitations 5.6, 2026-06-21, https://www.darktable.org/resources/camera-support/ (truy cập 2026-07-29); LibRaw 0.22 compile-time DNG SDK note, 2026-07-16, https://www.libraw.org/download (truy cập 2026-07-29); RawTherapee build artifact 5.13 không công bố cờ DNG SDK, 2026-07-26, https://github.com/RawTherapee/RawTherapee/releases/tag/5.13 (truy cập 2026-07-29).

### A4. Lệnh mẫu có thể dùng trong agent

Các ví dụ dưới đây dùng PowerShell, quote mọi đường dẫn và buộc CLI trả exit code; thay biến đường dẫn theo bundle của agent.

**RawTherapee 5.13 — lựa chọn mặc định, profile nền + delta do code sinh:**

```powershell
$rt = "D:\tools\RawTherapee-5.13"
$in = "D:\job\input"
$out = "D:\job\output"
$base = "D:\job\profiles\camera-base.pp3"
$delta = "D:\job\profiles\agent-delta.pp3"
$env:RT_SETTINGS = "D:\job\state\rt-settings"
$env:RT_CACHE = "D:\job\state\rt-cache"
& "$rt\rawtherapee-cli.exe" -o "$out" -p "$base" -p "$delta" -Y -t -b16 -a -c "$in"
if ($LASTEXITCODE -ne 0) { throw "RawTherapee failed: $LASTEXITCODE" }
```

- `[supported]` `-p` được layer theo thứ tự; `-t -b16` xuất TIFF 16-bit; `-a` nhận mọi loại ảnh được hỗ trợ trong folder; `-c` phải ở cuối; `RT_SETTINGS`/`RT_CACHE` cô lập trạng thái.
  - Nguồn: RawPedia “Command-Line Options”, n.d., https://rawpedia.rawtherapee.com/Command-Line_Options (truy cập 2026-07-29); RawPedia “File Paths”, n.d., https://rawpedia.rawtherapee.com/File_Paths (truy cập 2026-07-29).

**ART 1.26.7 — profile `.arp`, bundle portable:**

```powershell
$art = "D:\tools\ART-1.26.7"
& "$art\ART-cli.exe" -o "D:\job\output" -p "D:\job\profiles\base.arp" -p "D:\job\profiles\agent-delta.arp" -Y -t -b16 -c "D:\job\input"
if ($LASTEXITCODE -ne 0) { throw "ART failed: $LASTEXITCODE" }
```

- `[supported]` Tài liệu ART dùng chính pattern `ART-cli ... -p ... -Y -t -b16 -c`; `.arp` là text và bundle Win64 portable là artifact chính thức.
  - Nguồn: ART “User Commands”, n.d., https://artraweditor.github.io/Usercommands.html (truy cập 2026-07-29); ART release 1.26.7, 2026-07-13, https://github.com/artraweditor/ART/releases/tag/1.26.7 (truy cập 2026-07-29).

**darktable 5.6.0 — áp dụng golden XMP, cô lập DB/cache:**

```powershell
$dt = "C:\Program Files\darktable\bin\darktable-cli.exe"
& $dt "D:\job\input\IMG_0001.CR3" "D:\job\profiles\golden.CR3.xmp" "D:\job\output\IMG_0001.tif" --hq true --apply-custom-presets false --library ":memory:" --core --configdir "D:\job\state\dt-config" --cachedir "D:\job\state\dt-cache" --disable-opencl
if ($LASTEXITCODE -ne 0) { throw "darktable-cli failed: $LASTEXITCODE" }
```

Batch một thư mục với history mặc định/XMP cạnh file:

```powershell
& $dt "D:\job\input" "D:\job\output" --out-ext tiff --hq true --apply-custom-presets false --library ":memory:" --core --configdir "D:\job\state\dt-config" --cachedir "D:\job\state\dt-cache" --disable-opencl
if ($LASTEXITCODE -ne 0) { throw "darktable batch failed: $LASTEXITCODE" }
```

- `[verified]` `darktable-cli` chạy pure console; XMP là đối số tùy chọn; folder output phải tồn tại; `--apply-custom-presets false` bỏ `data.db` để cho phép nhiều instance nhưng không dùng style; `--library :memory:` loại trạng thái DB lâu dài.
  - Nguồn: darktable-cli manual, n.d., https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/ (truy cập 2026-07-29); darktable invocation manual, n.d., https://docs.darktable.org/usermanual/4.2/en/special-topics/program-invocation/darktable/ (truy cập 2026-07-29).

**LibRaw 0.22.2 — probe trước, render fallback một file:**

```powershell
$lr = "D:\tools\LibRaw-0.22.2-Win64\bin"
& "$lr\raw-identify.exe" -u -f "D:\job\input\IMG_0001.ARW"
if ($LASTEXITCODE -ne 0) { throw "Unsupported/corrupt RAW" }
& "$lr\dcraw_emu.exe" -w -H 2 -6 -T -Z "D:\job\output\IMG_0001.tiff" "D:\job\input\IMG_0001.ARW"
if ($LASTEXITCODE -ne 0) { throw "LibRaw decode failed: $LASTEXITCODE" }
```

- `[supported]` `-H 2` là blend highlight (0 clip, 1 unclip, 2 blend, 3+ rebuild), `-6` 16-bit, `-T` TIFF, `-Z filename.suf` đặt output cụ thể. `dcraw_emu` là sample/reference; production agent nên gọi LibRaw API hoặc wrapper của mình để kiểm soát metadata, màu và lỗi có cấu trúc.
  - Nguồn: LibRaw `samples/dcraw_emu.cpp` tag 0.22.2, 2026-07-16, https://github.com/LibRaw/LibRaw/blob/0.22.2/samples/dcraw_emu.cpp (truy cập 2026-07-29); LibRaw samples, n.d., https://www.libraw.org/docs/Samples-LibRaw.html (truy cập 2026-07-29).

### A5. Rủi ro, giới hạn và kiểm thử bắt buộc

- `[inference]` **Preflight bắt buộc**: probe từng file; log decoder/camera/mode, dimensions, bit depth và lỗi; fail closed nếu extension hợp lệ nhưng decoder không hỗ trợ mode nén.
  - Nguồn: LibRaw `raw-identify` documentation, n.d., https://www.libraw.org/docs/Samples-LibRaw.html (truy cập 2026-07-29); darktable camera limitations 5.6, 2026-06-21, https://www.darktable.org/resources/camera-support/ (truy cập 2026-07-29).
- `[inference]` **Fixture matrix** tối thiểu trước khi ship bundle: 1 ARW chuẩn + 1 mode mới; 1 CR3 chuẩn + burst/dual-pixel nếu dự kiến; DNG Bayer điện thoại; Apple ProRAW không nén và JPEG-XL; Samsung Expert RAW; HEIF 8/10-bit có orientation/ICC. Với mỗi file, so sánh dimensions, histogram RAW, white balance, orientation, metadata, pixel checksum của output deterministic và crop 100% vùng highlight.
  - Nguồn: hạn chế format từ darktable/LibRaw/RawTherapee/ART trong A2, truy cập 2026-07-29.
- `[inference]` **Không overwrite input**; output vào job directory mới; lưu recipe + phiên bản binary + SHA-256 + stderr. Một kết quả có exit code 0 vẫn phải được decode lại để xác minh ảnh tồn tại, kích thước đúng và không phải preview nhúng.
  - Nguồn: thiết kế kiểm chứng đề xuất từ hành vi CLI/manual trong A4, truy cập 2026-07-29.
- `[supported]` **HEIF không phải RAW** trong phần lớn camera điện thoại: iPhone dùng HEIF cho “High Efficiency”, còn Apple ProRAW là `.dng`. Tách nhánh `phone-rendered-heif` khỏi nhánh `sensor/raw-dng`; không áp dụng kỳ vọng highlight recovery RAW lên HEIF đã tone-map.
  - Nguồn: Apple Support “About Apple ProRAW”, cập nhật 2024-10-28, https://support.apple.com/en-us/119916 (truy cập 2026-07-29); ART HEIC plugin docs, n.d., https://artraweditor.github.io/Customformats (truy cập 2026-07-29).
- `[open]` **Kiểm chứng thực máy còn thiếu trong nghiên cứu này**: chưa chạy bốn binary trên cùng bộ fixture ARW/CR3/DNG/HEIF. Vì vậy “RawTherapee đáng tin nhất” là kết luận triển khai dựa trên packaging + CLI/profile contracts, chưa phải benchmark chất lượng pixel trên corpus.
  - Nguồn: phạm vi kiểm chứng của ledger, 2026-07-29.

## B. Coaching lúc chụp và tạo dáng cho nhóm kỷ yếu đại học bằng điện thoại

### B1. Kịch bản coaching tại hiện trường

Kịch bản dưới đây là quy trình đề xuất cho một nhóm bạn chụp kỷ yếu bằng camera sau của điện thoại. Các câu trong dấu ngoặc kép là lời nhắc ngắn có thể nói nguyên văn.

1. `[inference]` **Xin phép và đặt kỳ vọng (20 giây):** “Mình sẽ làm mẫu bằng chính người mình; nếu cần chạm để sửa áo/tay mình sẽ hỏi trước. Ai có dáng hoặc góc không thoải mái cứ nói ngay.” Ưu tiên chỉ dẫn bằng lời và mirroring; không nhận xét cân nặng, giới, “khuyết điểm” cơ thể hay ép một người vào dáng đau/khó giữ.
   - Nguồn: Sue Bryce, “Sue’s Posing Rules” — dùng mirroring để chỉ dáng, n.d., https://www.creativelive.com/class/glamour-photography-sue-bryce/lessons/sue-s-posing-rules (truy cập 2026-07-29); nguyên tắc đồng thuận và tránh body-shaming là đề xuất đạo đức của ledger, 2026-07-29.
2. `[supported]` **Chọn nền và sáng trước khi xếp người (30–60 giây):** đưa nhóm vào bóng râm sáng, quay mặt về vùng trời mở/nguồn sáng tán xạ; tránh mảng nắng gắt loang trên mặt, nền rối và cột/cành “mọc” khỏi đầu. Nếu dùng nắng ngược, kiểm tra mặt vẫn đủ sáng và vùng trời/áo trắng chưa cháy.
   - Nguồn: Apple Newsroom, mẹo Portrait mode — tìm bóng râm, đặt mặt trời sau chủ thể, giảm xao nhãng nền, 2016-12-06, https://www.apple.com/newsroom/2016/12/pro-photo-tips-for-using-portrait-mode-on-iphone-7-plus.html (truy cập 2026-07-29); Adobe Research, “Dynamic Guidance for Decluttering Photographic Compositions”, 2021-10-10, https://research.adobe.com/publication/dynamic-guidance-for-decluttering-photographic-compositions/ (truy cập 2026-07-29).
3. `[inference]` **Dựng “bộ xương” nhóm (45 giây):** chọn 1–2 người neo ở giữa; xếp các khuôn mặt thành tam giác/đường cong thay vì một hàng ngang; so le chiều cao bằng bậc thềm hoặc người trước-người sau; kéo nhóm đủ gần để vai chồng nhẹ nhưng không che mặt. Lời nhắc: “Hai bạn giữa sát nửa bước; hàng sau vào đúng khe vai; nghiêng vai về tâm nhóm; đừng để đầu nào mọc đúng từ vai bạn trước.”
   - Nguồn: Canon Australia/Jenn Cooper, “Family Photography Tips” — giảm khoảng trống giữa các khuôn mặt và hình dung tam giác/vòng tròn cho nhóm lớn, n.d., https://www.canon.com.au/get-inspired/family-photography-tips-jenn-cooper (truy cập 2026-07-29); Lindsay Adler, “The Posing Series” — dựng family pose từng phần để đạt cohesion và làm đẹp từng người, n.d., https://learn.lindsayadlerphotography.com/product/the-posing-series/ (truy cập 2026-07-29).
4. `[inference]` **Chỉnh từng người từ chân lên (30 giây):** “Hai bàn chân đừng song song như chụp thẻ; một chân lùi/nới nhẹ, dồn trọng lượng thoải mái; gối mềm; người xoay nhẹ về tâm nhóm; đứng cao nhưng vai thả.” Giữ bàn chân của người đứng ngoài không chĩa ra khỏi nhóm; không dùng một công thức “nam/nữ” cứng nhắc.
   - Nguồn: Sue Bryce, “Sue’s Posing Rules” — pose từ bàn chân lên, dùng bất đối xứng và thay đổi chân/hông để tạo đường nét, n.d., https://www.creativelive.com/class/glamour-photography-sue-bryce/lessons/sue-s-posing-rules (truy cập 2026-07-29); Lindsay Adler, “The Posing Series” — perspective, lens/camera angle, placement of feet và tránh dáng tĩnh, n.d., https://learn.lindsayadlerphotography.com/product/the-posing-series/ (truy cập 2026-07-29).
5. `[supported]` **Chỉnh cằm, vai, tay, mắt (30 giây):** “Trán/cằm đưa nhẹ về máy rồi hạ rất ít; đừng rụt cổ. Vai thả, một vai gần máy hơn. Tay phải có việc: giữ bằng, cầm mũ, chỉnh ve áo, ngón cái trong túi hoặc ôm vai bạn; ngón mềm, không nắm chặt, không ép má. Nhìn thẳng vào ống kính; mí dưới siết rất nhẹ nếu thấy tự nhiên, không nheo cả mắt.”
   - Nguồn: Peter Hurley, “How to Get a Better Jawline in Photos”, 2012-02-16, https://www.youtube.com/watch?v=Qe3oJnFtA_k (truy cập transcript 2026-07-29); Peter Hurley, “The Squinch”, 2013-11-20, https://www.youtube.com/watch?v=ff7nltdBCHs (truy cập transcript 2026-07-29); Sue Bryce, “Day 7: The Rules — Chin, Shoulders, Hands”, n.d., https://www.creativelive.com/class/28-days-portrait-photography-sue-bryce/lessons/day-7-the-rules-chin-shoulders-hands (truy cập 2026-07-29).
6. `[inference]` **Chụp ba nhịp, không chỉ một frame:** (a) formal — tất cả nhìn máy, cười nhẹ; (b) connection — người ngoài nhìn/vỗ vai người giữa rồi cùng cười; (c) motion — cả nhóm đi chậm một nhịp hoặc tung mũ ở khu vực trống, an toàn. Đếm “3–2–1” nhưng bấm một chuỗi ngắn trước và sau “1”; sau mỗi nhịp, quét từ mép trái sang phải để tìm mắt nhắm, mặt bị che, tay cụt và chân bị cắt.
   - Nguồn: Google, “5 features for taking perfect group photos with Pixel 10” — mô tả vấn đề biểu cảm không đồng nhất và framing lệch trong ảnh nhóm, 2025-10-06, https://blog.google/products-and-platforms/devices/pixel/pixel-group-photo-features-ai/ (truy cập 2026-07-29); Adobe Research decluttering overlay, 2021-10-10, https://research.adobe.com/publication/dynamic-guidance-for-decluttering-photographic-compositions/ (truy cập 2026-07-29).
7. `[inference]` **Safety frame:** lặp lại một ảnh formal ở tiêu cự/góc rộng hơn một chút, vẫn dùng camera chính nếu đủ chỗ; giữ khoảng thừa quanh tay, mũ và chân để crop. Không kết thúc cho đến khi có ít nhất hai frame liên tiếp mà mọi khuôn mặt rõ, không chớp và không bị che.
   - Nguồn: PhotoFramer phân biệt shift/zoom/view-change để hướng dẫn bố cục lúc chụp, CVPR 2026, https://openaccess.thecvf.com/content/CVPR2026/html/You_PhotoFramer_Multi-modal_Image_Composition_Instruction_CVPR_2026_paper.html (truy cập 2026-07-29); quy tắc hai safety frame là đề xuất vận hành của ledger, 2026-07-29.

### B2. Nguyên tắc posing chân dung và nhóm

- `[supported]` **Peter Hurley — jawline và mắt:** “forehead out and down” là một dịch chuyển nhỏ của đầu về phía camera rồi hạ nhẹ để tách đường hàm; “squinch” là nâng/siết nhẹ mí dưới, không phải nhắm chặt mí trên. Cả hai là cue tùy chọn; dừng nếu biểu cảm trở nên gượng.
  - Nguồn: Peter Hurley official YouTube, 2012-02-16, https://www.youtube.com/watch?v=Qe3oJnFtA_k; 2013-11-20, https://www.youtube.com/watch?v=ff7nltdBCHs (metadata và transcript truy cập 2026-07-29).
- `[supported]` **Lindsay Adler — pose là hệ thống góc nhìn, không phải danh sách dáng:** kiểm soát perspective, tiêu cự/góc máy, góc mặt; rà các lỗi tay; tạo biến thể có hệ thống; với nhóm/family, dựng từng người để cả tổng thể gắn kết mà vẫn tôn từng cá nhân.
  - Nguồn: Lindsay Adler, “The Posing Series”, n.d., https://learn.lindsayadlerphotography.com/product/the-posing-series/; “Posing Hands”, n.d., https://learn.lindsayadlerphotography.com/product/posing-hands-guide/ (truy cập 2026-07-29).
- `[supported]` **Sue Bryce — “chin, shoulders, hands”, body language và connection:** kéo dài tư thế, cằm nhẹ ra trước/xuống, tạo quan hệ giữa cằm và vai; tay phải mềm và có lý do trong ngôn ngữ cơ thể, không bóp má hay xuất hiện vô cớ; đặt toàn pose rồi mới gọi mắt lên để lấy kết nối.
  - Nguồn: CreativeLive/Sue Bryce, “Day 7: The Rules — Chin, Shoulders, Hands”, n.d., https://www.creativelive.com/class/28-days-portrait-photography-sue-bryce/lessons/day-7-the-rules-chin-shoulders-hands; “Sue’s Posing Rules”, n.d., https://www.creativelive.com/class/glamour-photography-sue-bryce/lessons/sue-s-posing-rules (truy cập 2026-07-29).
- `[supported]` **Nhóm — nhịp điệu mặt và khoảng cách:** tránh một hàng phẳng; so le độ cao/độ sâu có kiểm soát, tạo tam giác, cho vai chồng nhẹ để giảm khoảng trống và tăng cảm giác liên kết. Nếu tạo nhiều lớp sâu, phải kiểm tra tất cả mắt còn trong vùng nét.
  - Nguồn: Canon Australia/Jenn Cooper, “Family Photography Tips” — giảm khoảng trống giữa mặt và dùng tam giác/vòng tròn cho nhóm lớn, n.d., https://www.canon.com.au/get-inspired/family-photography-tips-jenn-cooper (truy cập 2026-07-29); Lindsay Adler, “The Posing Series”, n.d., https://learn.lindsayadlerphotography.com/product/the-posing-series/ (truy cập 2026-07-29).
- `[supported]` **Tay, cằm, mắt, chân là một chuỗi kiểm tra:** chân tạo nền và hướng cơ thể; vai tạo bất đối xứng; tay tiếp tục body language; cằm tách cổ/hàm; mắt hoàn tất connection. Với camera góc rộng, người ở mép và bộ phận gần máy dễ bị phóng đại, nên giữ mặt khỏi mép khung và không đưa bàn tay/bàn chân quá gần ống kính.
  - Nguồn: Sue Bryce “Sue’s Posing Rules”, n.d., URL ở trên; Nikon, “Quick Tips for Taking Better Portraits” — ống quá rộng làm méo mặt, n.d., https://www.nikonusa.com/learn-and-explore/c/tips-and-techniques/quick-tips-for-taking-better-portraits (truy cập 2026-07-29).
- `[inference]` **Quy tắc bao trùm:** coach theo mục tiêu hình ảnh (“mở”, “gắn kết”, “năng động”, “trang trọng”), khả năng vận động và mức thoải mái của từng người; không gán dáng theo giới hoặc dùng cue thẩm mỹ như một phán xét cơ thể.
  - Nguồn: tổng hợp có giới hạn từ ba hệ posing ở trên; nguyên tắc giảm thiên kiến do ledger đề xuất, 2026-07-29.

### B3. Paper/lab về pose suggestion, composition assistance và on-camera AI coaching

| Mốc | Hệ thống / paper | Bằng chứng liên quan | Giới hạn cần ghi vào skill |
|---|---|---|---|
| 2020 | Adobe/Stanford, **Adaptive Photographic Composition Guidance** (CHI 2020) | Overlay harmonic armature thích nghi theo saliency giúp người ít kinh nghiệm tìm bố cục; nhiều đường cùng lúc có thể gây quá tải. | Chỉ hướng dẫn bố cục, chưa coach pose người. |
| 2021 | Adobe/Stanford, **Dynamic Guidance for Decluttering Photographic Compositions** (UIST 2021) | Overlay dựa trên saliency/edge làm nổi distractor gần biên chủ thể và biên ảnh; đánh giá cho thấy người dùng tự tin hơn khi dọn bố cục. | Không chứng minh chất lượng ảnh khách quan hay tính tổng quát ngoài study. |
| 2023 | NAVER Labs Europe et al., **PoseFix** (ICCV 2023) | Dataset pose nguồn–pose đích kèm lời sửa; hai task là text-based pose editing và sinh correctional text. | Pose 3D/dataset, không phải portrait coach trực tiếp trên điện thoại. |
| 2024 | MPI/ETH et al., **ChatPose** (CVPR 2024) | Đưa pose SMPL thành token trong MLLM để hiểu, lý luận và sinh pose 3D từ ảnh/text. | Năng lực semantic/3D; không đánh giá thẩm mỹ ảnh nhóm tại hiện trường. |
| 2025 | Chinese Academy of Sciences et al., **UniPose** (CVPR 2025) | Framework LLM hợp nhất hiểu, sinh và sửa pose qua ảnh, text và SMPL 3D. | Foundation task; chưa phải UX coaching thời gian thực. |
| 2025 | vivo Camera Research, **Photography Perspective Composition** (NeurIPS 2025) | Đi xa hơn crop 2D: đề xuất thay đổi viewpoint/perspective và video minh họa đường chuyển đến góc đẹp hơn. | Mục tiêu là bố cục/perspective; không giải quyết pose nhóm hay consent. |
| 2025 | Google **Camera Coach** trên Pixel 10 | Sản phẩm dùng Gemini, scan preview rồi hướng dẫn từng bước về framing, ánh sáng, composition, zoom và mode; một phần model chạy cloud. | Bằng chứng sản phẩm, không phải paper đánh giá độc lập; phụ thuộc thiết bị/kết nối và preview rời máy cần cân nhắc riêng tư. |
| 2026 | **CLEP** (CVPR 2026) | Contrastive language–pose pretraining trên CLEP-2M; cải thiện zero-shot retrieval và pose generation/editing. | Mô hình nền pose–language, chưa sinh lời coach portrait đã kiểm chứng. |
| 2026 | **BioCoach** (CVPR 2026) | Kết hợp appearance, 3D kinematics và biomechanics để sinh feedback fitness từ streaming video. | Miền fitness có target pose/constraint; không nên chuyển thẳng chuẩn “đúng/sai” sang tạo dáng chân dung. |
| 2026 | **PhotoFramer** (CVPR 2026) | Từ ảnh bố cục kém, sinh chỉ dẫn text và ảnh mẫu cho ba thao tác shift, zoom-in, view-change; code/model/dataset được công bố. | Ảnh mẫu là sinh tổng hợp; phải trình bày như minh họa, không như ground truth về người thật. |
| 2026 | **ShutterMuse** (preprint 2026-06-24) | CaptureGuide-Bench gồm composition decision/refinement phía người chụp và scene-conditioned pose recommendation phía chủ thể; dataset 130K; paper báo cáo model tổng hợp tốt nhất phía người chụp và pose cạnh tranh với chi phí thấp hơn. | Mới là preprint; chính tác giả cho thấy MLLM tổng quát định vị refinement kém chính xác và hệ crop chuyên dụng không cho pose guidance hữu dụng. |

- Nguồn cho bảng: Adobe Research/CHI 2020, https://research.adobe.com/conferences_series/adaptive-photographic-composition-guidance/; Adobe Research/UIST 2021, https://research.adobe.com/publication/dynamic-guidance-for-decluttering-photographic-compositions/; PoseFix/ICCV 2023, https://openaccess.thecvf.com/content/ICCV2023/html/Delmas_PoseFix_Correcting_3D_Human_Poses_with_Natural_Language_ICCV_2023_paper.html; ChatPose/CVPR 2024, https://openaccess.thecvf.com/content/CVPR2024/html/Feng_ChatPose_Chatting_about_3D_Human_Pose_CVPR_2024_paper.html; UniPose/CVPR 2025, https://openaccess.thecvf.com/content/CVPR2025/html/Li_UniPose_A_Unified_Multimodal_Framework_for_Human_Pose_Comprehension_Generation_CVPR_2025_paper.html; PPC/NeurIPS 2025, https://papers.neurips.cc/paper_files/paper/2025/hash/8227285e32f70e07fa3a247f3a48006d-Abstract-Conference.html; Google Camera Coach, 2025-09-03, https://blog.google/products-and-platforms/devices/pixel/how-to-use-camera-coach/; CLEP/CVPR 2026, https://openaccess.thecvf.com/content/CVPR2026/html/Jia_CLEP_Contrastive_Language-Pose_Pretraining_CVPR_2026_paper.html; BioCoach/CVPR 2026, https://openaccess.thecvf.com/content/CVPR2026/html/Ji_From_3D_Pose_to_Prose_Biomechanics-Grounded_Vision-Language_Coaching_CVPR_2026_paper.html; PhotoFramer/CVPR 2026, https://openaccess.thecvf.com/content/CVPR2026/html/You_PhotoFramer_Multi-modal_Image_Composition_Instruction_CVPR_2026_paper.html; ShutterMuse, 2026-06-24, https://arxiv.org/abs/2606.25763 (tất cả truy cập 2026-07-29).
- `[verified]` **Xu hướng đến 29/07/2026:** nghiên cứu đã chuyển từ crop hậu kỳ sang chỉ dẫn lúc chụp gồm đổi viewpoint, quyết định keep/refine/reject và pose theo scene; điều này được xác nhận độc lập bởi PPC, PhotoFramer và ShutterMuse.
  - Nguồn: NeurIPS 2025 PPC, CVPR 2026 PhotoFramer và arXiv 2026 ShutterMuse ở dòng nguồn của bảng (truy cập 2026-07-29).
- `[open]` **Khoảng trống triển khai:** chưa tìm thấy paper peer-reviewed chứng minh một coach thời gian thực, chạy on-device, xử lý ổn định nhóm đông bằng camera điện thoại và đã đánh giá đồng thời về chất lượng ảnh, latency, consent, khác biệt cơ thể/vận động và thiên kiến văn hóa. Camera Coach là sản phẩm gần nhất; ShutterMuse sát bài toán nhất nhưng còn là preprint.
  - Nguồn: phạm vi và giới hạn công bố của Google Camera Coach, PhotoFramer và ShutterMuse, truy cập 2026-07-29.

### B4. Checklist trước khi bấm máy để ảnh dễ hậu kỳ

- `[supported]` **Thiết bị:** lau lens; đủ pin/dung lượng; bật grid + level; ưu tiên camera sau 1×, chỉ dùng 2×/3× khi đó là camera quang học và ánh sáng đủ; tránh đặt mặt sát mép 0.5×. Bật RAW+JPEG/ProRAW nếu máy hỗ trợ và đã thử workflow A; vẫn giữ một JPEG/HEIF xem nhanh.
  - Nguồn: Google Pixel Camera Help — dirty-lens warning, grid, RAW+JPEG, n.d., https://support.google.com/pixelcamera/answer/2838995; Apple iPhone guide — grid/level và focus/exposure, n.d., https://support.apple.com/en-my/guide/iphone/iph3dc593597/ios; Apple ProRAW guide, n.d., https://support.apple.com/en-gb/guide/iphone/iphae1e882a3/ios; Nikon — ống quá rộng làm méo mặt, n.d., https://www.nikonusa.com/learn-and-explore/c/tips-and-techniques/quick-tips-for-taking-better-portraits (truy cập 2026-07-29).
- `[inference]` **Ánh sáng:** tìm ánh sáng tán xạ đều/bóng râm sáng; tránh hotspot và bóng cứng khác nhau giữa các mặt; nếu backlight, xoay/di chuyển đến khi mặt vẫn nhận fill từ trời mở. Tránh trộn nguồn có màu quá khác nhau nếu không thể tắt/bù.
  - Nguồn: Apple Newsroom portrait tips, 2016-12-06, https://www.apple.com/newsroom/2016/12/pro-photo-tips-for-using-portrait-mode-on-iphone-7-plus.html; Apple Newsroom setup với ánh sáng tự nhiên tán xạ và bóng râm đều, 2021-02-12, https://www.apple.com/newsroom/2021/02/how-to-capture-stunning-floral-photos-with-iphone-12-pro-models/ (truy cập 2026-07-29).
- `[supported]` **Nền và biên:** nền đơn giản; bỏ rác/chữ/cột sáng; kiểm tra đường chân trời; nhìn dọc bốn mép để không cắt ngón tay, mũ, tà áo hoặc bàn chân. Chừa crop margin nhưng không lạm dụng ultrawide.
  - Nguồn: Adobe Research decluttering, 2021-10-10, https://research.adobe.com/publication/dynamic-guidance-for-decluttering-photographic-compositions/; Google framing hints/level, n.d., https://support.google.com/pixelcamera/answer/14106982 (truy cập 2026-07-29).
- `[inference]` **Mặt phẳng nét:** với nhóm đông, đưa mắt các hàng về các lớp độ sâu gần nhau nhất có thể; nếu Portrait mode làm mờ sai tóc/mũ/áo tốt nghiệp hoặc mặt hàng sau, chuyển về Photo thường. Chụp một frame test và phóng 100% cả mặt giữa lẫn hai mép.
  - Nguồn: Canon Australia/Jenn Cooper — giảm khoảng trống giữa mặt trong nhóm lớn, n.d., https://www.canon.com.au/get-inspired/family-photography-tips-jenn-cooper; Canon Australia/Anupam Singh — group shot cần nhiều vùng nét hơn, n.d., https://www.canon.com.au/get-inspired/fashion-photography-101-essential-tips; Apple xác nhận Portrait mode dùng depth effect, n.d., https://support.apple.com/en-ie/guide/iphone/iphd7d3a91a2/26/ios/26 (truy cập 2026-07-29).
- `[inference]` **Focus/exposure cho da nhưng bảo vệ highlight:** tap vào mặt ở vùng sáng trung bình; khóa AE/AF nếu khung không đổi; hạ exposure vừa đủ khi trán, áo trắng, bằng hoặc trời bắt đầu mất chi tiết. Không mặc định “underexpose thật sâu”: ảnh điện thoại thiếu sáng nặng sẽ tăng noise và mất màu da.
  - Nguồn: Apple iPhone guide — face detection cân bằng nhiều mặt, tap focus, kéo exposure và AE/AF Lock, n.d., https://support.apple.com/en-my/guide/iphone/iph3dc593597/ios; Apple portrait tips — có thể giảm exposure nhẹ trong bối cảnh phù hợp, 2016-12-06, URL ở trên (truy cập 2026-07-29).
- `[supported]` **Tắt làm đẹp/hiệu ứng phá tính linh hoạt:** chọn filter Original; tắt face retouching; với ảnh cần hậu kỳ nghiêm túc, tránh Portrait blur nếu segmentation chưa sạch. Ở chế độ documentary, không dùng Auto Best Take/Add Me vì chúng có thể ghép nhiều frame/người.
  - Nguồn: Apple iPhone guide — filter có tùy chọn Original, n.d., https://support.apple.com/en-my/guide/iphone/iph3dc593597/ios; Google Pixel Camera Help — Face retouching có Off/Subtle/Smooth, n.d., https://support.google.com/pixelcamera/answer/14106982; Google mô tả Auto Best Take tạo composite và Add Me ghép hai ảnh, 2025-10-06, https://blog.google/products-and-platforms/devices/pixel/pixel-group-photo-features-ai/ (truy cập 2026-07-29).
- `[inference]` **Bộ ảnh tối thiểu:** 2 safety frame formal, 1 biến thể gần, 1 biến thể toàn thân, 1 interaction và 1 motion; kiểm tra mắt/mặt/occlusion ngay tại chỗ. Giữ nguyên file gốc và metadata; đừng chỉ giữ bản đã qua app social.
  - Nguồn: vấn đề biểu cảm nhóm từ Google Pixel group photo article 2025-10-06 ở trên; quy trình lưu safety set và original là đề xuất vận hành của ledger, 2026-07-29.

## C. Đạo đức hậu kỳ ảnh tài liệu

### C1. World Press Photo

> Phạm vi: đây là **Entry Rules/verification của World Press Photo Contest 2026**, một mốc nghiêm ngặt hữu ích cho chế độ documentary; không nên gọi nó là luật phổ quát cho mọi tòa soạn.

- `[supported]` **Cho phép:** ảnh single-frame/single-exposure; crop bỏ chi tiết thừa; xóa bụi cảm biến hoặc vết xước trên scan âm bản; chỉnh màu hoặc chuyển grayscale nếu không đổi nội dung. Thay đổi mật độ, tương phản, màu, saturation chỉ hợp lệ khi không che, xóa hoặc làm biến dạng thông tin trong ảnh.
  - Nguồn: World Press Photo, “What counts as manipulation — 2026 Contest”, n.d., https://www.worldpressphoto.org/contest/verification-process/what-counts-as-manipulation; “2026 Contest Entry Rules”, n.d., https://www.worldpressphoto.org/contest/entry-rules (truy cập 2026-07-29).
- `[supported]` **Cấm:** multiple exposure, polyptych và stitched panorama; thêm, sắp xếp lại, lật, làm biến dạng hoặc xóa người/vật; xóa dấu trên cơ thể, vật nhỏ, vệt phản sáng, bóng đổ hoặc vật sát biên bằng heal/clone; thêm highlight, chi tiết vật thể, montage hay nới biên bằng vật liệu nhân bản.
  - Nguồn: World Press Photo, “What counts as manipulation”, n.d., URL ở trên; 2026 Judging Procedures, 2026, https://www.worldpressphoto.org/getmedia/d229f86b-453b-4e78-ab2a-0ed3c294a4ed/2026-Contest-Judging-Procedures.pdf (truy cập 2026-07-29).
- `[supported]` **AI:** cấm ảnh tổng hợp, generative fill và mọi AI upscaler như Adobe Super Resolution/Topaz Photo AI vì chúng đưa thông tin mới vào ảnh. WPP nói limited denoise, auto levels/color/contrast và object selection cho local adjustment *có thể* được chấp nhận nếu không thay đổi đáng kể toàn ảnh và không thêm/xóa thông tin; mức cuối cùng do tổ chức/jury quyết định.
  - Nguồn: World Press Photo 2026 Entry Rules, điều 19–22, n.d., https://www.worldpressphoto.org/contest/entry-rules; “What counts as manipulation”, mục AI tools, n.d., URL ở trên (truy cập 2026-07-29).
- `[supported]` **Điện thoại trong contest 2026:** chỉ ảnh chụp ở standard shooting mode đủ điều kiện; HDR, Portrait mode, creative lighting effects và panorama mode không đủ điều kiện. Đây là quy định contest cụ thể, không phải khẳng định rằng mọi HDR điện thoại đều là giả.
  - Nguồn: World Press Photo 2026 Entry Rules, điều 20, n.d., https://www.worldpressphoto.org/contest/entry-rules (truy cập 2026-07-29).
- `[supported]` **Staging/posing và caption:** không được cố ý đánh lừa bằng cách tái dựng/dàn dựng sự kiện. Portrait có pose là một thể loại hợp lệ, nhưng mọi chỉ dẫn của photographer và ảnh hưởng trực tiếp lên scene phải được khai trong caption; portrait không được giả một scene hoặc sửa dấu trên mặt/cơ thể.
  - Nguồn: World Press Photo 2026 Code of Ethics, điều 2, n.d., https://www.worldpressphoto.org/contest/code-of-ethics; “What counts as manipulation”, mục staging, n.d., URL ở trên (truy cập 2026-07-29).
- `[supported]` **Provenance/verification:** ảnh vào vòng cuối phải cung cấp file như camera ghi. Với smartphone hoặc full-format JPEG, WPP yêu cầu ảnh chưa sửa cùng chuỗi ít nhất bảy frame: ba trước, frame dự thi, ba sau. Hai analyst độc lập đối chiếu original/entry theo layer, blend, histogram và 100% pixel; caption phải trả lời who/what/where/when/why và khai pose/consent.
  - Nguồn: World Press Photo 2026 Verification Process, n.d., https://www.worldpressphoto.org/contest/verification-process; “How is manipulation detected?”, n.d., https://www.worldpressphoto.org/contest/verification-process/how-is-manipulation-detected; “What is required in captions?”, n.d., https://www.worldpressphoto.org/contest/what-is-required-in-captions (truy cập 2026-07-29).

### C2. Associated Press (AP)

- `[supported]` **Cho phép có giới hạn:** crop, dodge/burn, grayscale, xóa bụi cảm biến/vết xước bản scan, normal toning và chỉnh màu — chỉ ở mức tối thiểu cần cho tái hiện rõ và chính xác, nhằm khôi phục bản chất chân thực của ảnh.
  - Nguồn: AP, “News Values and Principles — Telling the Story”, mục Visuals/Photo, n.d., https://www.ap.org/about/news-values-and-principles/telling-the-story/ (truy cập 2026-07-29).
- `[supported]` **Cấm:** thay đổi density/contrast/color/saturation làm scene khác đáng kể; làm mờ hoặc xóa nền bằng burn/aggressive toning; kể cả xóa “red eye” cũng không được phép. AP không cho thêm hoặc bớt bất kỳ phần tử nào trong ảnh tin tức.
  - Nguồn: AP, “Telling the Story”, mục Visuals/Photo, n.d., URL ở trên; AP, “Image Integrity” cho freelancer/contractor, n.d., https://www.ap.org/privacy-policy/ (truy cập 2026-07-29).
- `[verified]` **Generative AI:** hướng dẫn AP ngày 23/07/2026 tiếp tục cấm generative AI để **create, alter hoặc enhance** news photography. Hướng dẫn 2023 cũng cấm generative AI thêm/bớt phần tử; ảnh AI chỉ có thể xuất hiện khi chính nó là đối tượng được đưa tin và phải được ghi nhãn rõ, không được đóng vai một news photograph thật.
  - Nguồn: AP, “AP updates newsroom standards for artificial intelligence”, 2026-07-23, https://www.ap.org/the-definitive-source/announcements/ap-updates-newsroom-standards-for-artificial-intelligence/; AP, “Standards around generative AI”, 2023-08-15, https://www.ap.org/the-definitive-source/behind-the-news/standards-around-generative-ai/ (truy cập 2026-07-29).
- `[supported]` **Không staging:** AP không dàn dựng/tái diễn sự kiện. Chỉ yêu cầu pose khi làm portrait, và caption phải nói rõ đó là portrait/hoàn cảnh pose; nếu bên thứ ba đã yêu cầu pose và ảnh AP ghi lại việc đó, caption cũng phải nói rõ.
  - Nguồn: AP, “Telling the Story”, mục Practices/Fabrications/Photo, n.d., https://www.ap.org/about/news-values-and-principles/telling-the-story/ (truy cập 2026-07-29).
- `[supported]` **Graphic là nhánh khác:** photo-based graphic có thể mask/composite, nhưng phải rõ ràng là graphic, không được trông như một photograph ghi nhận thực tế và không được làm sai sự thật. Không được dùng ngoại lệ này để lách documentary mode.
  - Nguồn: AP, “Telling the Story”, mục Visuals/Graphics, n.d., URL ở trên (truy cập 2026-07-29).
- `[verified]` **Giao của WPP và AP:** crop tối thiểu, tonal/color content-preserving và xóa bụi cảm biến là vùng chung được phép; thêm/bớt nội dung, generative fill và tone làm mất thông tin là vùng chung bị cấm. AP 2026 nghiêm hơn WPP 2026 về generative AI enhancement.
  - Nguồn: World Press Photo 2026 manipulation rules và AP 2026 AI update/AP Photo rules ở C1–C2 (truy cập 2026-07-29).

### C3. Documentary ethics gate cho agent

`[inference]` Gate nên có ba profile, chọn **trước** khi mở editor:

| Profile | Mục tiêu | AI enhancement |
|---|---|---|
| `documentary-common-strict` | Giao an toàn của AP + WPP; mặc định khi user chỉ nói “documentary” | Block toàn bộ generative AI create/alter/enhance. |
| `documentary-ap-2026` | Ảnh tin tức theo mốc AP | Block generative AI create/alter/enhance; chỉ chỉnh thông thường tối thiểu. |
| `documentary-wpp-2026` | Chuẩn bị entry WPP 2026 | Có thể cho limited denoise/auto adjustment/selection không thêm-bớt thông tin, nhưng phải `ESCALATE` vì jury quyết định mức đáng kể; block AI upscaling/super-resolution. |

- Nguồn: World Press Photo 2026 Entry Rules điều 19–22 và AP AI update 2026-07-23 ở C1–C2 (truy cập 2026-07-29).

**Quyết định machine-actionable** (`[inference]`, thiết kế ledger 2026-07-29):

1. `BLOCK` nếu input không có original bất biến, provenance không rõ, là composite/multiple exposure/panorama, hoặc capture mode vi phạm profile đã chọn.
2. `BLOCK` mọi add/remove/rearrange/reverse/distort nội dung: generative fill, object removal/heal/clone ngoài bụi sensor/vết xước scan, sky/background replacement, face/body reshape, skin-mark removal, background blur nhân tạo, relight làm đổi sự kiện, frame synthesis, face swap/Best Take/Add Me.
3. `BLOCK` generative upscaling/sharpening/denoise trong `common-strict` và `ap-2026`; với `wpp-2026`, chỉ denoise/auto adjustment không thêm-bớt thông tin mới được `ESCALATE`, không auto-allow.
4. `ALLOW` crop; grayscale; chỉnh exposure/WB/tone/color thông thường và local dodge/burn ở mức tối thiểu **chỉ khi** so sánh original cho thấy không đổi hue đáng kể, không che/xóa/đưa thêm thông tin. `ALLOW` xóa bụi cảm biến hoặc vết xước scan; không mở rộng ngoại lệ này sang vật thật trong scene.
5. `ESCALATE` mọi thao tác không ánh xạ chắc chắn vào allowlist, mọi model AI không rõ có sinh pixel mới hay không, hoặc bất kỳ edit nào analyst 100%/histogram/difference view thấy có thể đổi meaning.
6. Luôn xuất `decision`, `policy_profile`, `operation`, `reason`, `source_rule`, `input_sha256`, `output_sha256`, binary/model version, recipe/sidecar/command, operator, UTC timestamp và caption/provenance note; không overwrite original.
7. Caption gate bắt buộc who/what/where/when/why; khai photographer influence, pose/reenactment, consent và mọi tình huống có thể khiến người xem hiểu sai. Portrait posed không được gắn nhãn như candid.
8. Verification gate render original/edited thành hai layer đã align; kiểm tra blink/difference, histogram và 100%; nếu không chứng minh edit content-preserving thì fail closed.

- Nguồn: World Press Photo verification/caption workflow và AP “Telling the Story” ở C1–C2 (truy cập 2026-07-29); mapping `ALLOW/BLOCK/ESCALATE` và audit schema là đề xuất triển khai của ledger, 2026-07-29.

`[open]` Không có ngưỡng số phổ quát cho “minimal”, “significant” hoặc “substantially alter”: cả WPP lẫn AP dùng phán xét biên tập/forensic theo ngữ cảnh. Agent không được tự bịa ngưỡng EV, saturation hay denoise rồi coi là compliance; trường hợp sát biên phải `ESCALATE` cho editor.

- Nguồn: WPP giao quyết định mức “significant” cho organization/global jury; AP yêu cầu hỏi senior photo editor khi nghi ngờ, các URL ở C1–C2 (truy cập 2026-07-29).

## Bổ sung đề xuất cho skill

### RAW PIPELINE

```markdown
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
```

### CAPTURE & POSING COACH

```markdown
## CAPTURE & POSING COACH

Use this block to coach a real university-graduation group while they are being photographed with a phone. Coach for the requested mood, comfort and mobility; never rank bodies, infer sensitive traits or assign poses by gender.

### Consent and communication

- Ask before touching clothing, hair or a person. Demonstrate/mirror the correction with your own body first. Stop any cue that hurts or feels exposing.
- Give one short actionable cue at a time; confirm the subject understood it. Describe visual intent (“gắn kết”, “trang trọng”, “năng động”), not a supposed body defect.

### 90-second field script

1. Light/background: move into bright open shade or diffused side/front light; remove bright clutter and poles behind heads.
2. Group skeleton: choose one or two anchors; arrange faces in triangles/curves with staggered heights; bring shoulders close enough for cohesion without hiding faces. Keep eye-depth layers compact enough to remain sharp.
3. Feet upward: offset one foot, soften knees, settle weight comfortably, turn torsos slightly toward group center and relax shoulders. Keep outer feet/shoulders pointing into the group.
4. Chin/eyes: cue a tiny forehead/chin movement toward the camera and slightly down; never force it. Optionally ask for a very light lower-lid “squinch”, not a hard squint. Reset expression by looking down, relaxing the mouth, then eyes back to lens.
5. Hands: every hand gets a believable job—hold diploma/cap, adjust lapel, thumb in pocket, or rest lightly on a friend. Keep fingers soft; no fists, face-squashing or unexplained “floating” hands.
6. Capture three beats: formal eye-to-lens; connected interaction; safe slow movement. Shoot a short sequence around the countdown and inspect every face, edge, hand and foot.
7. Take two clean formal safety frames plus a slightly wider frame with crop margin before releasing the group.

### Pre-shutter technical check

- Clean lens; battery/storage ready; rear 1× camera preferred; grid/level on. Keep faces away from ultrawide edges.
- Use RAW+JPEG/ProRAW only if the RAW pipeline has passed the device fixture; otherwise retain the highest-quality original JPEG/HEIF. Do not keep only social-app exports.
- Tap a mid-bright face, lock focus/exposure when framing is stable, and lower exposure only enough to preserve forehead, white gown/diploma and sky detail. Avoid severe underexposure.
- Use even light; avoid mixed color sources and patchy direct sun across faces. Scan the background and all four borders.
- For groups, test normal Photo mode first. Disable beauty filters/face retouching; turn off synthetic portrait blur if hair, caps, robes or rear-row faces segment poorly.
- If documentary mode is requested, disable multi-frame face substitution/compositing such as Best Take/Add Me and route the job through `DOCUMENTARY ETHICS GATE`.

### Generic pose illustration with image generation

Use image-gen only when a diagram would materially clarify a pose. Generate at most one neutral, clearly synthetic pose sheet unless the user asks for variations.

- Allowed subject: faceless wooden mannequin, simple stick figure, geometric silhouette or neutral 3D dummy showing limb/shoulder/foot relationships.
- Forbidden: any photorealistic person; any named, identifiable or real person; any attempt to reproduce a subject’s face/body/biometric likeness; any real reference photo supplied to image-gen.
- Prompt for plain background, full-body visibility, clear joint angles, no beauty ranking, no branding and no text unless essential. Label output: “Minh họa dáng tổng quát bằng hình tổng hợp; không mô tả người thật.”
- Never use the generated diagram as evidence that a real subject “should” look a certain way. Adapt every cue to consent, comfort, clothing and mobility.

### AI-coach confidence boundary

Google Camera Coach (2025) is product evidence for scene-based lighting/framing guidance. PhotoFramer (CVPR 2026) supports text plus synthetic composition exemplars. ShutterMuse (preprint, 2026-06-24) directly studies photographer-side framing and scene-conditioned pose recommendation, but is not peer-reviewed. Do not claim an on-device, bias-tested, real-time group portrait coach has been scientifically validated.

Evidence basis (accessed 2026-07-29): Peter Hurley official jawline/squinch videos (2012-02-16, https://www.youtube.com/watch?v=Qe3oJnFtA_k; 2013-11-20, https://www.youtube.com/watch?v=ff7nltdBCHs); Lindsay Adler Posing Series (n.d., https://learn.lindsayadlerphotography.com/product/the-posing-series/); Sue Bryce posing rules (n.d., https://www.creativelive.com/class/28-days-portrait-photography-sue-bryce/lessons/day-7-the-rules-chin-shoulders-hands); Adobe decluttering guidance (2021-10-10, https://research.adobe.com/publication/dynamic-guidance-for-decluttering-photographic-compositions/); Google Camera Coach (2025-09-03, https://blog.google/products-and-platforms/devices/pixel/how-to-use-camera-coach/); PhotoFramer/CVPR 2026 (https://openaccess.thecvf.com/content/CVPR2026/html/You_PhotoFramer_Multi-modal_Image_Composition_Instruction_CVPR_2026_paper.html); ShutterMuse preprint (2026-06-24, https://arxiv.org/abs/2606.25763).
```

### DOCUMENTARY ETHICS GATE

```markdown
## DOCUMENTARY ETHICS GATE

Run this gate before any edit when the image is news, documentary, evidence or contest work. Default to `documentary-common-strict`, the conservative intersection of AP and World Press Photo. A named publication/contest policy overrides only after its current primary rules are checked.

### Select a policy profile

- `documentary-common-strict`: block all generative AI creation, alteration and enhancement.
- `documentary-ap-2026`: AP baseline; generative AI may not create, alter or enhance news photography.
- `documentary-wpp-2026`: WPP Contest 2026 baseline; limited denoise/automatic adjustment/object selection that adds or removes no captured information must be escalated for human review, never auto-approved. AI upscaling/super-resolution remains blocked.

### Decision rules

Return exactly one of `ALLOW`, `BLOCK` or `ESCALATE` before invoking an editor.

`BLOCK` when any condition is true:

- Original camera file/provenance is missing or the requested profile rejects the capture mode.
- The operation adds, removes, rearranges, reverses or distorts scene content: generative fill, object removal/heal/clone except sensor dust or scan scratches, sky/background replacement, synthetic background blur, face/body reshaping, skin-mark removal, relighting that changes meaning, frame synthesis, face swap or multi-frame face substitution.
- The operation uses generative upscaling, sharpening or denoise under `common-strict`/`ap-2026`.
- The result is a composite, multiple exposure, stitched panorama or synthetic image presented as a documentary photograph.

`ALLOW` only when all conditions are true:

- Operation is limited to crop, grayscale, conventional exposure/WB/tone/color, minimally necessary local dodge/burn, sensor-dust removal or scan-scratch removal.
- Aligned original/edited comparison at 100%, difference view and histogram show no new/removed/obscured information and no material hue/scene change.
- The original remains immutable and the edit is fully reproducible from a saved recipe/command.

`ESCALATE` when an operation is not clearly on the allowlist, an AI model’s pixel-generation behavior is uncertain, WPP-limited AI enhancement is requested, or an edit could change meaning. There is no universal numeric EV/saturation/denoise threshold; do not invent one.

### Capture and caption gate

- For WPP 2026 smartphone submissions, standard shooting mode is required; HDR, Portrait mode, creative-lighting effects and panorama are ineligible. Preserve the unedited phone original plus at least three adjacent frames before and after the selected frame.
- Never stage or reenact an event. A directed portrait is allowed only when it is truthful and the pose/photographer influence is disclosed. AP likewise requires posed portraits to be identified in the caption.
- Caption must state who, what, where, when and why; disclose pose/reenactment, photographer influence, consent and any context needed to prevent a false reading.

### Audit record

Never overwrite the input. Record `decision`, `policy_profile`, `operation`, `reason`, `source_rule`, input/output SHA-256, capture metadata, tool/model/version, sidecar/recipe/command, operator, UTC timestamp, verification artifacts and caption/provenance note. If authenticity or compliance remains uncertain, fail closed and send the original plus audit bundle to a human photo editor.

Evidence basis (accessed 2026-07-29): World Press Photo 2026 Entry Rules and manipulation/verification/caption guidance (https://www.worldpressphoto.org/contest/entry-rules, https://www.worldpressphoto.org/contest/verification-process/what-counts-as-manipulation, https://www.worldpressphoto.org/contest/verification-process, https://www.worldpressphoto.org/contest/what-is-required-in-captions); AP Photo rules (n.d., https://www.ap.org/about/news-values-and-principles/telling-the-story/); AP AI update (2026-07-23, https://www.ap.org/the-definitive-source/announcements/ap-updates-newsroom-standards-for-artificial-intelligence/).
```

# Chỉnh sửa ảnh chuẩn nhiếp ảnh gia cho AI agent — SOTA đến 2026-07-28

> Trạng thái: hoàn tất · Hạn chót kiến thức: 2026-07-28
> Phạm vi cứng: chỉ chỉnh sửa tham số/tonal và hình học theo quy trình nhiếp ảnh; không dùng generative inpainting, resynthesis hay thay đổi danh tính/chủ thể.

## Mục lục

1. [Câu hỏi và tiêu chí đánh giá](#1-câu-hỏi-và-tiêu-chí-đánh-giá)
2. [Phương pháp và quy tắc bằng chứng](#2-phương-pháp-và-quy-tắc-bằng-chứng)
3. [Nền tảng nghề nghiệp: nhiếp ảnh gia, colorist, preset và LUT](#3-nền-tảng-nghề-nghiệp-nhiếp-ảnh-gia-colorist-preset-và-lut)
4. [Nghiên cứu SOTA: enhancement giữ danh tính và chỉnh sửa tham số bằng LLM/VLM](#4-nghiên-cứu-sota-enhancement-giữ-danh-tính-và-chỉnh-sửa-tham-số-bằng-llmvlm)
5. [So sánh CLI deterministic trên Windows](#5-so-sánh-cli-deterministic-trên-windows)
6. [Cách các sản phẩm AI hiện hành giữ danh tính](#6-cách-các-sản-phẩm-ai-hiện-hành-giữ-danh-tính)
7. [Nguyên tắc chống “AI slop” và kiểm định](#7-nguyên-tắc-chống-ai-slop-và-kiểm-định)
8. [Thiết kế đề xuất cho skill Neko](#8-thiết-kế-đề-xuất-cho-skill-neko)
9. [Khoảng trống, phản chứng và câu hỏi mở](#9-khoảng-trống-phản-chứng-và-câu-hỏi-mở)
10. [Nguồn gốc đã đọc](#10-nguồn-gốc-đã-đọc)
11. [Nhật ký cập nhật](#11-nhật-ký-cập-nhật)

## 1. Câu hỏi và tiêu chí đánh giá

### 1.1 Câu hỏi nghiên cứu

- Quy trình nào của nhiếp ảnh gia và colorist hàng đầu có thể biểu diễn thành tham số, mặt nạ và phép biến đổi deterministic?
- SOTA đến 2026-07-28 cho enhancement giữ danh tính, auto-retouch học từ chuyên gia, và điều khiển trình chỉnh ảnh bằng LLM/VLM là gì?
- CLI nào trên Windows phù hợp nhất với vòng lặp `VLM nhìn → đề xuất tham số → code áp dụng → VLM nhìn lại → lặp`?
- Lightroom, Photoshop và Google Photos tách chỉnh sửa tham số khỏi sinh nội dung như thế nào?
- Skill Neko cần schema, engine, guardrail và bộ kiểm định nào để tạo ảnh “đã xử lý bởi nhiếp ảnh gia” mà không resynthesis chủ thể?

### 1.2 Ràng buộc cứng

**Cho phép:** exposure, white balance, tone/parametric curves, HSL/color mixer, color grading, dodge/burn, crop/rotate/straighten/perspective, lens correction, sharpening/denoise truyền thống hoặc ML bảo toàn cấu trúc nếu chứng minh được, film emulation, local adjustment bằng mask không sinh pixel mới.

**Loại trừ mặc định:** generative fill/expand, inpainting, diffusion/GAN resynthesis, face swap, beauty filters thay hình học khuôn mặt/cơ thể, thay nền/đối tượng, hallucinated detail, relighting có tổng hợp hình học hoặc texture không quan sát được.

### 1.3 Tiêu chí đánh giá

| Nhóm | Tiêu chí |
|---|---|
| Bảo toàn | Danh tính, hình học, texture và nội dung cảnh không bị tái tổng hợp |
| Nghề nghiệp | Quy trình có thứ tự, mục đích thị giác, điểm dừng và khả năng hoàn tác |
| Determinism | Cùng input + recipe + phiên bản engine cho cùng output |
| Điều khiển | Tham số hữu hạn, có miền giá trị, mask rõ nguồn gốc, xuất recipe máy đọc được |
| Chất lượng | Không clipping ngoài chủ đích; màu da, neutral, contrast, gamut và noise được kiểm soát |
| Vận hành | Chạy headless trên Windows, batch được, giữ metadata/profile, kiểm tra exit code |
| Agentic loop | Preview nhanh, full render đáng tin, đo trước/sau, VLM critique có điều kiện dừng |

## 2. Phương pháp và quy tắc bằng chứng

- Ưu tiên nguồn gốc: paper/project page/repository của tác giả; tài liệu chính thức của Adobe, Google và dự án CLI; tài liệu/ghi chép trực tiếp của nhiếp ảnh gia hoặc colorist.
- Mỗi kết luận chính cần ít nhất hai nguồn độc lập khi có thể; nếu chỉ có một nguồn chính thức thì đánh dấu giới hạn.
- Ghi ngày xuất bản/cập nhật và ngày truy cập 2026-07-28; không dùng snippet tìm kiếm làm bằng chứng cuối.
- Trạng thái phát hiện: `[open]`, `[verified]`, `[refuted]`, `[superseded]`; kèm confidence `low/medium/high`.
- Chủ động tìm phản chứng: điểm CLI không deterministic, tính năng marketing trộn parametric với generative, paper đổi màu đẹp nhưng không thật sự bảo toàn danh tính.

## 3. Nền tảng nghề nghiệp: nhiếp ảnh gia, colorist, preset và LUT

### 3.1 Ansel Adams và Zone System

- `[verified · high]` **Zone System là planning-to-print, không phải preset contrast.** Center for Creative Photography (nơi giữ Ansel Adams Archive) ghi hệ thống do Adams và Fred Archer hình thành năm 1939/40: người chụp previsualize blacks/whites/grays của bản in, đo vùng, đặt exposure và phát triển negative cho kết quả đó. Development ngắn giảm contrast, dài tăng contrast; sheet film hợp nhất vì mỗi frame có thể nhận recipe riêng. Scale được nhóm low I–III, middle IV–VI, high VII–IX.  
  **Nguồn:** Center for Creative Photography, “Intimate Nature: Ansel Adams and the Close View”, không ghi ngày trang; truy cập 2026-07-28. Smithsonian xác nhận thư mục *Zone System Manual* (Minor White, 1968) tổ chức đúng chuỗi “previsualization, exposure, development, printing”.

- `[verified · medium-high]` **Hai tầng quyết định:** nghiên cứu lịch sử của Ira H. Latour tổng kết mô tả cuối đời của Adams thành (1) *image management* — viewpoint, optics và camera adjustment đến thời điểm exposure; (2) *value management* — exposure và negative development, tức “score” để bản in thực thi. Với agent số, mapping hữu ích là: `intent/composition/crop/perspective` trước; sau đó `tonal placement/exposure/curve/local print controls`; output render là “performance”, không được tự phát minh lại subject.  
  **Nguồn:** Ira H. Latour, “Ansel Adams, the zone system and the California School of Fine Arts”, *History of Photography* 22(2), 1998, pp. 147–154, DOI 10.1080/03087298.1998.10443870; abstract xuất bản online 2015-01-19, truy cập 2026-07-28.  
  **Giới hạn:** bài lịch sử và guide bảo tàng giải thích thực hành film B&W; ánh xạ sang RAW/color là diễn giải thiết kế, không phải lời Adams.

- `[verified · high]` **Nguyên tắc chuyển sang AI agent:** đặt tone theo ý đồ tương đối (EV/zone) và giữ headroom trước khi thêm look; mỗi ảnh có recipe riêng; local dodge/burn là bước “print interpretation” có kiểm soát. Không biến Zone System thành auto-HDR hay ép histogram phủ toàn dải—mục tiêu là rendering đã previsualize, không phải tối đa hóa dynamic range.

### 3.2 Quy trình colorist điện ảnh

- `[verified · high]` **Colorist tách correction/shot balance khỏi creative look.** FilmLight mô tả Base Grade nên là lớp đầu để cân exposure và color giữa shot; look sáng tạo được xây ở các lớp sau. Engine chuyển working image sang scene-linear, grade, rồi trả về working color space. Các điều khiển toàn ảnh là Flare, Balance, Contrast, Saturation; bốn vùng Dark/Dim/Light/Bright neo quanh 18% middle gray, tham số theo stop và có pivot/falloff. Cách biểu diễn này phù hợp hơn slider 0–100 tùy ý cho agent vì cùng ngôn ngữ với exposure và DP.  
  **Nguồn:** Andy Minuth/FilmLight, “Base Grade and the evolution of grading tools”, 2017-04-12; truy cập 2026-07-28.

- `[verified · high]` **Thứ tự có ý nghĩa vật lý:** gắn đúng input/project color space → đặt Flare/black zero point → Balance exposure và white/color balance → Contrast/Saturation → vùng tonal/local correction → look → output transform. FilmLight cảnh báo Flare sai làm mất quan hệ độ sáng; copy grade giữa shot phải xem lại Flare. Base Grade cho phép ±3 stop (extended ±6), nhưng correction quá mạnh vẫn có thể làm phẳng đường cong và mất phân tách tone dù tránh được negative-slope solarization.

- `[verified · medium]` **Film emulation là output/preview behavior, không phải nút “cinematic”.** Workflow DI truyền thống đặt film-print-emulation LUT trong preview/output path để mô phỏng phản ứng in/trình chiếu và soft clipping; grade phía trước LUT sẽ phản ứng theo “stock/output”. Đây là nguồn độc lập bổ trợ cho ARRI về việc khai báo domain và thứ tự LUT.  
  **Giới hạn:** bài FilmLight là mô tả sản phẩm của hãng, không phải thử nghiệm mù giữa nhiều engine; các kết luận định lượng về chất lượng không được suy rộng.

- `[verified · high]` **Node graph chuyên nghiệp có ba phạm vi:** Blackmagic mô tả primary correction toàn ảnh để tạo neutral starting point; secondary/qualifier/Power Window cho vùng cục bộ; group pipeline có pre-clip grade (balance chung), clip grade (sửa riêng shot) và post-clip grade (look/effect chung). RAW settings được xử lý non-destructively trước node editor; scopes, image wipe, difference matte, split screen và Lightbox là kiểm tra khách quan/so sánh, không chỉ “VLM thấy đẹp”.  
  **Nguồn:** Blackmagic Design, “DaVinci Resolve — Color”, trang hiện liệt kê Resolve 21, không ghi ngày cập nhật; truy cập 2026-07-28.

### 3.3 Triết lý preset, LUT và film emulation

- `[verified · high]` **Tách look sáng tạo khỏi biến đổi hiển thị.** ARRI mô tả Look File chỉnh màu trong log space, nơi dữ liệu màu còn đủ; Camera Image Core/Display Render Transform mới chuyển LogC rộng sang SDR/HDR đích và có thể clip/crush ở phép chuyển kỹ thuật đơn giản. Với ALF4/REVEAL (ALEXA 35/265), look là CDL cộng Creative Modification Transform (CMT, khuyến nghị LUT LogC4→LogC4), sau đó mới đến DRT LogC4→SDR/HDR. Đây là bằng chứng mạnh cho pipeline agent: `decode/linearize → technical normalization → creative parametric/LUT in wide-gamut scene/log space → output transform`, không bake look vào ảnh display-referred quá sớm.  
  **Nguồn:** ARRI, “What is an ARRI Look File?”, không ghi ngày trang; tài nguyên ALF4 workflow trên trang đề ngày 2025-09-30; truy cập 2026-07-28.  
  **Giới hạn:** LUT vẫn là ánh xạ màu toàn cục; nó không tự hiểu nội dung, không thay thế exposure/WB/shot balance và có thể gây clipping/gamut issue nếu dùng sai input color space.

- `[verified · high]` **Preset/LUT phải khai báo miền đầu vào/đầu ra và phiên bản.** ARRI nói LUT LogC3 không dùng hay chuyển đổi trực tiếp cho LogC4; look phải được tái tạo bằng mắt trong miền mới. Vì vậy recipe Neko không được chỉ lưu tên `.cube`: phải khóa `input_color_space`, `working_space`, `lut_hash`, `lut_domain`, `engine_version` và `output_transform`.

- `[verified · medium-high]` **Show LUT là “look anchor”, không phải final grade.** Colorist Aljoscha Hoffmann mô tả LUT được phát triển cùng DP từ camera test cho on-set/dailies; dailies colorist vẫn grade và trao đổi với DP hằng ngày, rồi final grading diễn ra sau conform. Tư duy preset đúng cho Neko là “khởi điểm có provenance + điều chỉnh theo ảnh”, không phải một-click final.  
  **Nguồn:** FilmLight, “Meet the Colourist: Aljoscha Hoffmann”, không ghi ngày bài; trang ©2026, truy cập 2026-07-28.  
  **Giới hạn:** interview không nói LUT có bake hay không, normalization giữa camera, hay node order; không được suy diễn các chi tiết này.

## 4. Nghiên cứu SOTA: enhancement giữ danh tính và chỉnh sửa tham số bằng LLM/VLM

### 4.1 Taxonomy và tiêu chí “identity-preserving”

- `[verified · high]` **Identity preservation nên được bảo đảm ở operation set, không giao cho aesthetic judge.** MonetGPT chỉ cho MLLM gọi thư viện procedural pre-authored; tác giả lập luận các phép này bảo toàn detail/resolution “by construction”, minh bạch và override được. Đây là loại bảo toàn phù hợp đề tài hơn paper diffusion tuy dùng face-ID/CLIP metric nhưng vẫn resynthesize pixel.  
  **Nguồn:** Dutt, Ceylan & Mitra, “MonetGPT: Solving Puzzles Enhances MLLMs’ Image Retouching Skills”, ACM TOG 44(4)/SIGGRAPH 2025, article 107; project page và arXiv:2505.06176, truy cập 2026-07-28.  
  **Giới hạn:** project page tuyên bố lợi thế identity preservation nhưng không nêu metric định lượng; vì vậy chỉ kết luận mạnh về *cấu trúc operation*, không kết luận hơn bao nhiêu về identity.

- `[refuted · high]` **Face-ID score cao vẫn có thể vi phạm danh tính theo nghĩa nhiếp ảnh.** MirrorPPR (ECCV 2026) dùng pre-trained DiT + LoRA để chuyển các thay đổi tinh vi về facial features và body proportions từ exemplar; abstract vẫn báo tốt hơn về “identity preservation”. Vì task chủ đích đổi hình học con người, nó bị loại hoàn toàn khỏi skill dù recognition embedding còn giống.  
  **Nguồn:** Liu et al., “MirrorPPR: Exemplar-Based Portrait Photo Retouching”, arXiv:2606.29308, submitted 2026-06-28, accepted ECCV 2026; truy cập 2026-07-28.

### 4.2 Auto-retouch học từ chuyên gia

- `[verified · high]` **MIT-Adobe FiveK (CVPR 2011) là nền móng có edit provenance.** 5,000 DNG đa cảnh; năm sinh viên nhiếp ảnh được đào tạo Lightroom chỉnh toàn bộ ảnh; archive có individual slider values + full adjustment history; output TIFF 16-bit ProPhoto RGB và semantic metadata. Đây là nguồn tốt để học recipe/sequence chứ không chỉ mapping pixel.  
  **Nguồn:** Bychkovsky et al., “Learning Photographic Global Tonal Adjustment with a Database of Input/Output Image Pairs”, CVPR 2011; official MIT CSAIL dataset page, truy cập 2026-07-28.  
  **Cảnh báo:** trang gọi file là Expert A–E nhưng mô tả người chỉnh là photography students, mục tiêu “visually pleasing, akin to a postcard”. Năm rendition khác nhau cho cùng RAW chứng minh không có một ground truth thẩm mỹ; convention “train Expert C” chỉ là benchmark, không phải chuẩn nhiếp ảnh gia duy nhất.

- `[verified · medium-high]` **Exposure (TOG 2018) mở đầu dòng white-box sequential filter policy.** Mạng học trên tập ảnh đã có style mong muốn nhưng không cần before/after pairs; các edit được mô hình hóa thành resolution-independent differentiable conventional filters; deep RL quyết định operation tiếp theo và tham số theo trạng thái ảnh; output là chuỗi edit hiểu được thay vì ảnh black-box. Đây là tiền thân trực tiếp của loop MonetGPT/RetouchAgent.  
  **Nguồn:** Hu et al., “Exposure: A White-Box Photo Post-Processing Framework”, ACM TOG/SIGGRAPH 2018, arXiv:1709.09602v2; official arXiv abstract, truy cập 2026-07-28.  
  **Giới hạn truy xuất:** PDF gốc MIT timeout và arXiv PDF không trích text được trong lượt nghiên cứu; không ghi filter list/range hay số đánh giá chưa kiểm chứng.

- `[verified · high]` **DeepLPF (CVPR 2020) đưa local adjustment vào white-box.** Thay pixel-level enhancement khó giải thích hoặc global edit quá thô, mạng hồi quy tham số của ba filter cục bộ: Elliptical, Graduated và Polynomial; filter sau đó mới áp lên ảnh. Tác giả xem parameterization này như regularization tự nhiên và báo SOTA trên hai biến thể MIT-Adobe5K với ít tham số hơn nhiều baseline.  
  **Nguồn:** Moran et al., “Deep Local Parametric Filters for Image Enhancement”, CVPR 2020, pp. 12826–12835, arXiv:2003.13985; CVF Open Access, truy cập 2026-07-28.  
  **Ứng dụng:** Neko nên biểu diễn dodge/burn/local WB bằng mask primitive có provenance (`ellipse`, `linear-gradient`, `luma-range`, optional subject mask frozen), không cho VLM vẽ lại vùng ảnh. Landing page không đủ công thức/range nên implementation phải dựa tài liệu/code trước khi claim tương thích DeepLPF.

- `[verified · high]` **PPR10K (CVPR 2021) thêm yêu cầu chân dung thực tế:** 11,161 RAW trong 1,681 group, mỗi ảnh do ba expert retouch, có high-resolution human-region mask. Benchmark tách Human-Region Priority (ưu tiên subject/người) và Group-Level Consistency (cùng người/cảnh phải có tone thống nhất). General FiveK models không tự đáp ứng hai yêu cầu này.  
  **Nguồn:** Liang et al., “PPR10K: A Large-Scale Portrait Photo Retouching Dataset With Human-Region Mask and Group-Level Consistency”, CVPR 2021, pp. 653–661; official CVF page/code link, truy cập 2026-07-28.  
  **Ứng dụng:** recipe Neko cần `protected_regions` và `batch_group_id/reference_frame`; verifier so subject skin/chroma/exposure và consistency giữa ảnh, không chỉ score từng ảnh độc lập.

- `[verified · high]` **RSFNet (ICCV 2023) học region-specific white-box filters song song.** Mạng phát saturation/contrast/hue arguments và attention map tương ứng; output là linear sum của các filtered results thay vì cascade global filters. Thiết kế phản ánh divide-and-conquer của colorist và cho user sửa strategy.  
  **Nguồn:** Ouyang et al., “RSFNet: A White-Box Image Retouching Approach using Region-Specific Color Filters”, ICCV 2023, pp. 12160–12169; CVF Open Access, truy cập 2026-07-28.  
  **Giới hạn:** filter/argument giải thích được nhưng learned attention map vẫn là output neural. Để deterministic/auditable, Neko phải serialize mask raster/vector, checksum và transform-to-original; không regenerate mask ngầm ở lần render sau.

- `[verified · high]` **ICELUT (ECCV 2024) compile model thành pure LUT inference.** Training dùng pointwise 1×1 conv cho màu và split fully connected cho global context, rồi chuyển cả hai thành LUT; deployment không chạy CNN. Trang ECCV báo 0.5 ms GPU/7 ms CPU, near-SOTA và code công khai.  
  **Nguồn:** Yang et al., “Taming Lookup Tables for Efficient Image Retouching”, ECCV 2024; official ECCV poster page, truy cập 2026-07-28.  
  **Ứng dụng/giới hạn:** rất hợp preview/batch deterministic sau khi LUT được khóa; global/color-only mapping bảo toàn geometry nhưng không làm local dodge/burn hay subject-aware protection. Không dùng tốc độ paper để suy ra tốc độ Windows/CLI nếu chưa benchmark local.

- `[verified · medium-high]` **LLF-LUT++ (arXiv 2025) ghép global LUT và local Laplacian có tham số.** Global path dùng basis 3D LUT + neural weight predictor; Gaussian/Laplacian pyramid, interpolation và local-Laplacian remap vẫn closed-form; mạng dự đoán `α` (detail) và `β` (dynamic-range) maps. Bản 480p báo HDR+ 28.43 dB, FiveK 26.06 dB; bảng runtime 4K trên V100 là 13.50 ms. High-frequency bands giữ edge/texture hiện có, không tuyên bố sinh detail mới.  
  **Nguồn:** Zhang et al., “High-resolution Photo Enhancement in Real-time: A Laplacian Pyramid Network”, arXiv:2510.11613, submitted 2025-10-13; truy cập 2026-07-28.  
  **Giới hạn:** neural weight/α/β maps phải serialize mới tái lập; halo vẫn là failure mode; code trên paper chỉ ở trạng thái “will be made available”. Đây là hướng research executor, không phải lựa chọn CLI production hiện tại.

- `[verified · medium-high]` **C²LUT là điểm mới sát cutoff nhất cho technical color (v2 2026-07-14).** Framework dùng chromaticity-aware illuminant representation + nonlinear 3D LUT, nén Tucker tensor để chạy trong camera ISP; dataset mới có 1,473 spectral power distributions. Abstract báo giảm CIE ΔE₀₀ *tới* 20% và angular error *tới* 18% so với phương pháp trước; code/data có link GitHub.  
  **Nguồn:** Rota et al., “Illuminant-Adaptive 3D Lookup Tables for Camera Color Correction”, arXiv:2607.11681v2, 2026-07-14; truy cập 2026-07-28.  
  **Giới hạn:** đây là camera color correction/illuminant adaptation, không phải aesthetic retouch hay VLM planner; abstract không nêu limitation. Đặt ở technical normalization trước creative grade, không dùng như preset look.

### 4.2.1 Tiến hóa của dòng auto-retouch white-box

`FiveK edit histories (2011) → sequential differentiable filters/RL (Exposure, 2018) → local parametric masks (DeepLPF, 2020) → portrait region/group criteria (PPR10K, 2021) → region-specific filter maps (RSFNet, 2023) → pure LUT deployment (ICELUT, 2024) → LUT + local Laplacian (LLF-LUT++, 2025) → MLLM procedural agents/reward/feedback (MonetGPT/JarvisArt/RetouchIQ/RetouchAgent, 2025–2026)`.

C²LUT và VLM-CC (2026) là nhánh technical color/white balance bổ trợ; chúng không thay thế creative retouch.

- `[verified · high]` **InstantRetouch (CVPR 2026) là high-fidelity learned executor mạnh nhất trong phạm vi photometric.** Model dự đoán bilateral grid thấp độ phân giải, mỗi cell có affine RGB `3×4`; learned guidance slice coefficients theo `(x,y,intensity)` rồi áp trực tiếp lên pixel full-resolution. Deployment không warp/repaint geometry. iRetouch có 500 before/after pairs từ cộng đồng Lightroom; training ~200K triplets dùng exposure/gamma/WB/contrast/curve/saturation/highlight-shadow/HSL degradations. Báo 4K 0.068 s, SSIM 0.989, CW-SSIM 0.973, DISTS 0.022.  
  **Nguồn:** Wu et al., “InstantRetouch: Efficient and High-Fidelity Instruction-Guided Image Retouching with Bilateral Space”, CVPR 2026, arXiv:2606.05071 (2026-06-03); official paper/project page, truy cập 2026-07-28.  
  **Giới hạn:** grid là learned transform, không phải slider dễ hiểu; inference khởi từ Gaussian noise nhưng không nêu fixed seed; out-of-gamut chỉ soft penalty; không hard runtime allowlist. Chỉ xem deterministic sau khi grid đã serialize/hash; dùng như optional compiled local color artifact, không thay recipe gốc.

- `[verified · high]` **VeraRetouch (arXiv 2026) minh họa trade-off fidelity↔auditability.** FastVLM-0.5B sinh ba hidden controls `Light/Global Color/Specific Color`; MLP per-pixel RGB renderer áp trực tiếp, không diffusion và không warp geometry. AetherRetouch-1M+ học từ inverse degradation/preset/Lightroom parameters; FiveK Auto báo 26.85 dB/0.939 sau DAPO-AE. Nhưng `latents-pred` 24.11 dB vượt named `params-pred` 18.07 dB bằng cách bỏ conventional parameter stack.  
  **Nguồn:** Guo et al., “VeraRetouch: A Lightweight Fully Differentiable Framework for Multi-Task Reasoning Photo Retouching”, arXiv:2604.27375v2, first submitted 2026-04-30; code/model official, truy cập 2026-07-28.  
  **Kết luận:** hình học an toàn hơn generative editor nhưng không reversible/editable theo chuẩn nghề nghiệp; local mask còn là future work. Không chọn làm core Neko, chỉ theo dõi như compiled renderer research.

### 4.3 LLM/VLM làm planner hoặc controller cho trình chỉnh ảnh

- `[verified · medium]` **PhotoArtAgent (arXiv 2025) phát biểu đúng loop Lightroom ở cấp hệ thống:** explicit artistic analysis → plan strategy → precise parameters qua Lightroom API → evaluate output → iterative refine, kèm rationale cho user. Abstract báo user study vượt automated tools và tương đương professional artists.  
  **Nguồn:** Chen et al., “PhotoArtAgent: Intelligent Photo Retouching with Language Model-Based Artist Agents”, arXiv:2505.23130v1, 2025-05-29; truy cập 2026-07-28.  
  **Giới hạn:** abstract không nêu parameter schema, model roles, số user study, code hay failure cases; do đó dùng làm pattern lịch sử, không dùng claim chất lượng làm bằng chứng chính.

- `[verified · high]` **MonetGPT là mẫu planner–executor–observer procedural.** Ba stage cố định: `(1) Lighting → (2) Saturation & White Balance → (3) Selective Color`; mỗi stage xuất operation + value + lý do, execute bằng function call, đưa intermediate image lại cho MLLM rồi mới lập kế hoạch stage sau. Model học trạng thái “không cần chỉnh” để tránh over-edit; user có thể override plan giữa chừng. Training dùng các “visual puzzle”: làm hỏng expert edit bằng operation biết trước, sinh reasoning có ground truth, rồi học đảo chuỗi.  
  **Kết quả tác giả báo:** trên Adobe FiveK vượt các baseline open-source không nêu tên và xấp xỉ Google Photos AutoEnhance; có expert/novice user study. Project page không công bố số, participant hay statistical test nên confidence cho so sánh chất lượng chỉ `medium-low`.

- `[verified · high]` **JarvisArt chứng minh tích hợp MLLM→Lightroom ở action space lớn.** Agent điều phối hơn 200 tool, hỗ trợ global và local/region refinement; học hai pha CoT-SFT rồi GRPO-R; Agent-to-Lightroom Protocol nối plan với phần mềm. MMArt-Bench lấy từ real-world user edits; abstract NeurIPS báo trung bình pixel-level content-fidelity metrics tốt hơn GPT-4o 60% trong khi instruction following tương đương. Repo đã phát hành inference/training/eval/data scripts, preview weights, MMArt-PPR10K (có instruction + Lua/XMP + ảnh trước/sau) và MMArt-Bench.  
  **Nguồn:** Lin et al., “JarvisArt: Liberating Human Artistic Creativity via an Intelligent Photo Retouching Agent”, NeurIPS 2025; official proceedings và GitHub `LYL1015/JarvisArt`, cập nhật đến 2025-12-08; truy cập 2026-07-28.  
  **Giới hạn quan trọng:** “content fidelity” pixel metric không đồng nghĩa chứng minh danh tính; full tool list/miền tham số không có trên landing page và toolset >200 không được cam kết tonal-only. Neko chỉ nên học protocol/plan representation, còn executor phải dùng allowlist nhỏ hơn.

- `[verified · high]` **RetouchIQ (CVPR 2026) chuyển intent thành executable Lightroom recipe và học reward theo từng ảnh.** Policy Qwen2.5-VL-7B autoregress reasoning + chuỗi tham số (ví dụ `{exposure=+0.9; contrast=-30}`); Generalist Reward Model cùng backbone nhìn instruction + before/after, tự sinh tiêu chí ngôn ngữ cho case rồi chấm scalar. Training gồm SFT trên 190K image–instruction/reasoning pairs và RL với policy-generated weak edits, tránh phụ thuộc duy nhất vào một reference pixel target.  
  **Kết quả:** RetouchEval có 300 pairs thuộc quality/style/local; Adobe5K lấy 400 ảnh. Trên Adobe5K, RetouchIQ-GRM báo SSIM 0.86, LPIPS 0.16, PSNR 23.14, nhỉnh hơn MonetGPT 0.82/0.17/23.10 và các baseline trong bảng.  
  **Nguồn:** Wu et al., “RetouchIQ: MLLM Agents for Instruction-Based Image Retouching with Generalist Reward”, CVPR 2026, pp. 12279–12288, arXiv:2602.17558; truy cập 2026-07-28.  
  **Phản chứng/giới hạn:** SC/PQ của RetouchEval do GLM-4.5V chấm, không phải human study; paper không công bố full action schema/range hay formal identity metric; “best” không đúng cho mọi cột. Neko nên dùng VLM judge để gợi ý/so sánh, không làm guardrail duy nhất.

- `[verified · high]` **RetouchAgent (AAAI 2026) hiện thực closed loop gần nhất với yêu cầu.** Bốn vai trò logic: Analysis xác định intent; Retrieval lấy top-3 expert cases bằng CLIP image + text intent (0.6/0.4); Engine phát JSON operation/value; Reflection chấm 4 trục aesthetics/lighting/color fidelity/intent alignment, threshold 8/10, tối đa 8 vòng và giữ toàn history. Library lấy cảm hứng Lightroom, nêu exposure/temperature/contrast/tone curves/highlights/shadows; mỗi operation nhận một giá trị chuẩn hóa `[-100,100]`.  
  **Kết quả:** FiveK 500 test, trung bình 24.69 dB/0.940; PPR10K 2,286 test; user study 40 người×150 ảnh chọn RetouchAgent 44.8% so với DiffRetouch 28.6%, PIENet 18.2%, 3D-LUT 8.4%. Ablation Expert C: full 26.02/0.938; bỏ reflection 21.35/0.816; chỉ history vòng trước 24.76/0.854; restart mỗi vòng 24.84/0.862.  
  **Nguồn:** Zhang & Yang, “RetouchAgent: Towards Interactive and Explainable Image Retouching with MLLM Agents”, AAAI 40(35), 2026-03-14, pp. 29901–29910, DOI 10.1609/aaai.v40i35.40237; truy cập 2026-07-28.  
  **Giới hạn:** chỉ dùng GPT-4o cho mọi vai trò, full operation formulas không công bố, không identity-specific metric, không báo cost/latency hay độ tin cậy của reflection score. Neko có thể dùng một VLM ở nhiều phase thay vì buộc multi-agent; hard verifier phải độc lập.

- `[verified · high]` **PhotoAgent (ICML 2026) có search/commit loop mạnh nhưng toàn hệ thống không đạt ràng buộc.** Perceiver đề xuất atomic actions; MCTS rollout depth 3/20 simulations trên preview; top-K được render/rescore full-resolution; chỉ commit một action nếu reward tốt hơn, rồi replan từ ảnh thật. Ở 1/2 resolution, top-1/top-3 retention là 85%/100% (Spearman 0.94), ủng hộ preview search + final render.  
  **Loại khỏi executor:** pool gồm FLUX.1 Kontext, Step1X-Edit, thêm/xóa/sửa vật thể, thay nền, thêm mặt trời/chim—đều resynthesis. CLIP similarity 0.6254 cao nhất bảng nhưng chỉ là semantic preservation, không identity proof; không có hard allowlist hay face/landmark/structure metric.  
  **Nguồn:** Yao et al., “PhotoAgent: Exploratory Visual Aesthetic Planning with Large Vision Models”, ICML 2026, arXiv:2602.22809 (2026-02-26); truy cập 2026-07-28.  
  **Kết luận dùng:** mượn `preview search → full-res rescore → improve-only commit → replan`; thay toàn bộ router bằng allowlist parametric của Neko.

- `[verified · medium]` **LumiVideo (arXiv 2026) tách semantic planner khỏi deterministic color compiler.** Perception đo percentiles IRE 1/50/99 + VLM JSON; ToT/RAG tìm tham số `Lift RGB, Gamma RGB, Gain RGB, saturation, contrast, pivot`; executor sample transform thành LUT 33³ `.cube` và áp trilinear. Reflection khóa nguyên tham số không được nhắc, tối đa 5 vòng. Một LUT toàn cục không sinh geometry/pixel semantics và tránh frame-wise stochastic flicker; đây là pattern tốt cho ảnh tĩnh và batch consistency.  
  **Nguồn:** Guo et al., “LumiVideo: An Intelligent Agentic System for Video Color Grading”, arXiv:2604.02409v1, 2026-04; truy cập 2026-07-28.  
  **Giới hạn:** chỉ global LUT, không mask/window/secondary; “protected hue” không có projection toán học; không công bố bounds/formula/schema đầy đủ; VLM planning không deterministic; paper có nhiều mâu thuẫn số giữa table/prose và không có temporal/structural metric. Vì vậy không dùng tuyên bố “absolute/zero degradation” như sự thật đã chứng minh.

- `[verified · high]` **VLM-CC (CVPR 2026) chứng minh pattern “VLM phân loại, code giải số” cho white balance.** Thay vì bắt VLM dự đoán RGB/Kelvin, ảnh được WB bằng estimate hiện tại và chuyển pseudo-sRGB; Qwen2.5-VL-7B LoRA chỉ trả một token `{red, green, blue}` cho residual cast. Solver quay vector illuminant trên tangent plane với step giảm 3°→0.1°, tối đa 20 vòng; khi ba nhãn tạo vòng refinement thì dừng và lấy normalized geometric mean ba estimate cuối. Phép áp dụng là channel-wise division + ma trận camera→XYZ→sRGB, không resynthesis.  
  **Kết quả:** leave-one-dataset-out trên Gehler-Shi mean/median/worst-25% angular error 1.52°/1.18°/3.29°; NUS-8 1.83°/1.44°/3.88°; Cube+ 1.51°/1.09°/3.28°. Iterative discrete 1.52° vượt one-step numerical 3.59° mean.  
  **Nguồn:** Li, Tan & Tan, “White-Balance First, Adjust Later: Cross-Camera Color Constancy via Vision-Language Evaluation”, CVPR 2026, pp. 1331–1341, arXiv:2605.19613; truy cập 2026-07-28.  
  **Giới hạn:** một global illuminant, cần camera CCM (Sony IMX135 bị loại khi thiếu), không báo runtime/repeat variance/deterministic decoding và có một mâu thuẫn số trong discussion. Pattern nên dùng cho WB; không suy rộng trực tiếp sang toàn bộ thẩm mỹ.

### 4.3.1 Kết luận SOTA tool-based đến 2026-07-28

- **Mạnh nhất về operation-safe/identity-by-construction:** MonetGPT.
- **Mạnh nhất về Lightroom-scale action space và protocol:** JarvisArt.
- **Mạnh nhất về instruction-conditioned reward/evaluation:** RetouchIQ.
- **Gần nhất với loop đề bài:** RetouchAgent; PhotoAgent bổ sung preview tree search nhưng action space gốc không an toàn.
- **Mạnh nhất về tách semantic VLM khỏi deterministic numeric compiler:** VLM-CC (WB) và LumiVideo (global CDL/LUT), dù LumiVideo cần tái lập độc lập.
- **Mạnh nhất về learned photometric representation giữ geometry/texture:** InstantRetouch bilateral grid; độ auditability kém named filters nên là optional compiled path.
- **Mạnh nhất về conversational preference/refinement trong toolset global nhỏ:** IEA; chưa có local mask hay production Lightroom conformance.

- `[verified · high]` **IEA (CVPR Findings 2026) học hội thoại trên action space nhỏ, minh bạch.** Qwen2.5-VL-7B điều khiển 16 global parameters kiểu Lightroom, integer `[-100,100]`, JSON; ba stage SFT→GRPO→synthetic generalization học edit, tóm tắt preference từ history và refine 1–2 dimensions theo feedback. Editor mô phỏng chạy 50–300 ms; Stage-3 đạt pixel distance 0.103 và reward alignment 7.387. User study 56 người×50 cases: IEA có instruction rank tốt nhất trong tool-calling methods và quality rank 3.69, nhưng generative baselines bám instruction tốt hơn.  
  **Nguồn:** Zhu et al., “IEA: Amateur-Friendly Conversational Image Editing Agent via Three Stages of Multitask Alignment”, CVPR Findings 2026, arXiv:2606.08016; truy cập 2026-07-28.  
  **Giới hạn:** 16 global tools, local examples bị loại; simulated matplotlib editor không chứng minh tương thích Lightroom thật; không identity metric hay multi-turn retention test. Dùng `Image-Summary`/`Image-Refine` pattern cho preference memory, không dùng làm local engine.

### 4.4 Datasets, metrics và giới hạn đánh giá

- `[verified · high]` **Không có một metric đơn lẻ đủ dùng.** Pixel/reference metrics (L1/L2/PSNR/SSIM/LPIPS) đo gần expert target nhưng phạt những edit hợp lệ khác; VLM semantic/perceptual scores bám intent hơn nhưng có bias/circularity; user study đo preference nhưng tốn kém và khó tái lập. RetouchIQ tự nêu creative editing là subjective/non-unique và single-reference reward không đáng tin, nhưng chính evaluation SC/PQ lại dựa vào một VLM judge. Thiết kế Neko phải tách: (a) hard invariants do executor/recipe; (b) signal/structure metrics; (c) aesthetic critique; (d) user acceptance.

- `[verified · high]` **Reflection/history có giá trị thực nghiệm, nhưng score không phải safety proof.** RetouchAgent ablation giảm mạnh khi bỏ reflection hoặc chỉ giữ vòng gần nhất; điều này ủng hộ loop tích lũy history. Tuy nhiên reflection tự chấm color fidelity không thay thế kiểm tra invariant danh tính/cấu trúc, vì paper không đo face identity hay semantic correspondence.

- `[open · medium]` LumiVideo báo metric/model-judge và user/pro colorist study tích cực, nhưng có reporting inconsistency, không variance/significance và thiếu release manifest. Dùng làm thiết kế tham khảo, không xếp “SOTA chất lượng” chắc chắn cho đến khi code/data/conformance được tái lập.

- `[verified · high]` **Color constancy có metric vật lý rõ hơn aesthetic retouch.** VLM-CC dùng angular error của illuminant trên nhiều camera/dataset và Worst-25% để lộ failure tail. Với Neko, WB verifier nên dùng neutral/known-color/skin-chroma diagnostics và cảnh báo confidence; không để aesthetic reward che sai color cast.

- `[verified · high]` **Expert rendition không phải ground truth duy nhất.** FiveK chứa năm edit hợp lệ và mục tiêu chủ quan; RetouchIQ cũng chỉ ra single-reference pixel reward không phù hợp creative editing. Benchmark nên báo cả fidelity tới nhiều reference/style và preference/intent, không tối ưu mù PSNR tới Expert C.

- `[verified · high]` **Ảnh chân dung cần metric theo vùng và theo bộ.** PPR10K xác định HRP/GLC; điều này gần workflow wedding/editorial hơn metric ảnh đơn. Neko nên test face/skin protected-region drift và group consistency trước/sau cùng scene/reference.

- `[verified · high]` **NTIRE 2026 dùng metric để shortlist, expert để xếp cuối.** Photography Retouching Transfer yêu cầu suy ra retouch từ cặp reference before/after rồi áp cho input mới, giữ quality/fidelity; có 76 participants, 7 final. Full-reference metrics sàng top methods, sau đó imaging-expert user study quyết định ranking. Top methods dùng implicit neural representation + test-time optimization/meta-learning/refinement, hiệu quả nhưng không tự cho named/auditable recipe.  
  **Nguồn:** Elezabi et al., “Photography Retouching Transfer, NTIRE 2026 Challenge: Report”, CVPRW 2026, pp. 1796–1806; CVF Open Access, truy cập 2026-07-28. PDF body timeout nên không ghi số ranking/dataset chưa xác nhận.

## 5. So sánh CLI deterministic trên Windows

### 5.1 Ma trận sơ bộ

**Trạng thái máy nghiên cứu (2026-07-28):** `ffmpeg 7.1.1-essentials_build` có trên PATH; `magick`, `vips`, `darktable-cli`, `rawtherapee-cli` không có. Vì vậy chỉ FFmpeg được smoke-test local; bốn engine còn lại đánh giá từ tài liệu gốc, không có benchmark hiệu năng trên máy này.

| Engine | Mô hình xử lý | RAW/color management | Local mask | Recipe tái lập | Windows/headless | Vai trò dự kiến |
|---|---|---:|---:|---:|---:|---|
| ImageMagick 7 | Ordered raster CLI graph | Không phải RAW developer; ICC/colorspace có nhưng phải khai báo tường minh | Mạnh: read/write mask, compose, alpha | Tốt nếu lưu argv + profiles + build; không bit-exact cross-build | Native Windows | Geometry/mask/composite + fallback raster |
| libvips | Demand-driven, horizontally threaded graph | LittleCMS/ICC, scRGB/OKLab; không phải camera-RAW developer | Tốt qua graph/composite, cần tự dựng mask | Rất tốt nếu serialize graph/version; CLI đơn lẻ bất tiện | Prebuilt Windows | Preview/batch/final raster core qua binding |
| darktable-cli | Scene-referred RAW pixelpipe + XMP history | Rất mạnh; lens/RAW/exposure/color calibration/display transform/ICC | Rất mạnh: vector, parametric, raster/external | Tốt khi khóa XMP/config/build; default GUI/DB phải vô hiệu hóa | Native, headless | **RAW master + local grade chính** |
| RawTherapee CLI | RAW pipeline + PP3 text profiles | Rất mạnh; 16-bit TIFF/PNG, camera pipeline | Mạnh trong GUI (RT-spots/content-aware), PP3 local schema chưa được đặc tả | **Rất tốt cho global** nhờ PP3 text/partial profiles; khóa version | Native, headless | RAW alternative; global/base recipe dễ sinh |
| FFmpeg filters | Frame/video filtergraph | Mạnh cho primaries/TRC/matrix/range; không RAW/ICC-photo pipeline | Có `maskedmerge`, nhưng mask orchestration thủ công | Tốt same-build khi khóa graph/pixfmt/threads; không hứa cross-build | Native, headless; đã smoke-test 7.1.1 | Video/timelapse/sequence parity, không phải still RAW chính |

### 5.2 ImageMagick 7

- `[verified · high]` **Điểm mạnh:** một ordered operation graph cực rộng cho crop/rotate/distort/deskew, channel math, `-brightness-contrast`, gamma/sigmoid/level, `-color-matrix`, ASC-CDL (`-cdl`), 1D CLUT/Hald 3D LUT, `-read-mask`/`-write-mask`, alpha/composite. Phù hợp tạo mask, geometry, thumbnail/preview và final raster sau RAW decode.
- `[verified · high]` **Color discipline bắt buộc:** untagged input bị giả định non-linear sRGB; `RGB` nghĩa linear, `sRGB` non-linear; `-set colorspace` chỉ đổi metadata còn `-colorspace` đổi pixel. Nên attach/convert ICC rõ ràng, làm phép cần ánh sáng trong linear RGB, rồi output transform + embed profile. Không dựa vào default channel/colorspace vì manual có context-dependent defaults.
- `[verified · high]` **Không phải lựa chọn số 1 cho RAW/photo recipe:** không có semantics kiểu exposure EV/WB camera/lens/demosaic/history stack; `-auto-level` rất nhạy outlier và manual cảnh báo không hợp nhiều ảnh thật. Recipe là argv dài, quoting Windows dễ lỗi; local mask có thể làm nhưng orchestration phức tạp.
- `[verified · medium-high]` **Determinism:** cùng input/argv/profile/build thường tái lập, nhưng Quantum depth, HDRI, delegate/codec và format metadata là build-dependent; không hứa bit-exact giữa máy/version. Khóa `magick -version`, Q-depth/HDRI, ICC hashes, output format/depth và dùng `-regard-warnings`.

**Vai trò đề xuất:** engine phụ cho geometry, mask algebra, compositing và diagnostics; không làm RAW/color pipeline chính.

**Nguồn:** ImageMagick official “Command-line Options” và “Color Management”, truy cập 2026-07-28.

### 5.3 libvips

- `[verified · high]` **Ưu thế hệ thống:** demand-driven, partial-image intermediates và horizontally threaded I/O cho pipeline dài, ít RAM; phù hợp VLM loop cần render nhiều preview rồi một full-res. Windows có precompiled `vips-dev-w64-*.zip`; bản `web` có tập decoder nhỏ/an toàn hơn bản `all`.
- `[verified · high]` **Color và toán ảnh:** có sRGB/scRGB linear, Lab/LCh, OKLab/OKLCh, HSV, XYZ; LittleCMS cho `icc_import/export/transform`; có ΔE76/ΔE00/CMC. Operations đủ cho linear/recomb/gamma/LUT/tone curve, crop/affine/rotate, composite/mask algebra.
- `[verified · high]` **Ranh giới CLI:** `vips.exe` expose một `VipsOperation` mỗi invocation. Một recipe 10–30 bước chạy tốt nhất qua `pyvips`/Node/C binding để dựng một lazy graph; shell gọi nhiều lệnh sẽ materialize intermediates và mất lợi thế. Vì skill Neko là code-driven, đây vẫn là điểm cộng: executor compile JSON→graph, không compile JSON→chuỗi shell dài.
- `[verified · high]` **Không phải RAW developer:** `rawload` trong API là đọc raw pixel buffer; không cung cấp workflow camera demosaic/lens/profile/history ngang darktable/RawTherapee. Dùng nó sau khi RAW đã được render sang scene/working-space TIFF/EXR.
- `[verified · medium-high]` **Determinism:** point operations/graph đã khóa thường tái lập, nhưng library không hứa byte-identical cross-version/build/codec/thread; khóa libvips + dependency versions, ICC, output encoder và hash output. Nếu invariant yêu cầu bitexact, benchmark repeated runs và cân nhắc single-thread cho phép reduction/statistics—đây là khuyến nghị thiết kế, không phải guarantee từ manual.

**Vai trò đề xuất:** raster engine chính cho preview, metrics và final RGB/TIFF/PNG sau RAW decode; wrap bằng binding, không dùng pure `vips.exe` làm DSL.

**Nguồn:** libvips official homepage/install guide, “How it works”, Developer checklist, Colour/Histogram/Conversion API (library 8.18 trên docs hiện hành), truy cập 2026-07-28.

### 5.4 darktable-cli

- `[verified · high]` **Đây là lựa chọn đầy đủ nhất cho RAW + local grade chuyên nghiệp.** Pipeline scene-referred giữ dữ liệu RAW ở thang linear không chặn rồi mới nén dynamic range ở display transform. Workflow chính thức: lens correction nếu cần → `exposure` đặt mid-gray/brightness nghệ thuật → `filmic rgb` đặt white/black relative exposure và contrast → `color balance rgb` cho saturation/look. White-balance module thường để nguyên; sửa illuminant/chromatic adaptation ở `color calibration`.
- `[verified · high]` **Recipe render là XMP history stack, nhưng thứ tự có hai nghĩa.** Danh sách module trong pixelpipe chạy từ dưới lên; history chỉ ghi thứ tự thao tác của người dùng. CLI có thể nhận XMP cụ thể, tự tìm sidecar nếu bỏ qua, hoặc lấy history từ `--library`. Neko phải luôn truyền XMP tuyệt đối và không suy execution order từ history-row order.
- `[verified · high]` **Local adjustment là first-class.** Có drawn masks (brush/circle/ellipse/path/gradient), parametric masks trên kênh scene RGB `g/R/G/B/Jz/Cz/hz`, tổ hợp set union/intersection/difference/exclusion, raster mask tái dùng cho module phía sau. Shapes lưu dạng vector trong tọa độ RAW gốc và đi qua lens/rotate/perspective/crop cùng pixelpipe. AI object mask được vector hóa thành nhóm Bézier; model/prompt không cần ở lúc render—phù hợp nếu Neko chỉ dùng AI để phân đoạn rồi khóa hình học, không sinh pixel.
- `[verified · high]` **Có đường nhập mask ngoài không-generative.** `external raster mask` đọc PFM/PNG, scale về kích thước ảnh và đưa mask rất sớm trong linear RAW pipe. Mask ngoài phải cùng orientation với sensor RAW; nó chỉ dùng được bởi module ở sau nguồn mask. Executor phải lưu file mask + SHA-256 + orientation/source dimensions.
- `[verified · high]` **Reproducibility không đến từ defaults.** `--apply-custom-presets` mặc định `true` và đọc `data.db`; style cần configdir; không nêu format option thì CLI dùng cấu hình export cuối của GUI; bỏ XMP thì tự tìm sidecar. Recipe tái lập phải truyền XMP, output extension, ICC type/file/intent, format options, configdir cô lập và `--apply-custom-presets false` khi không cần style. Disable DB cho phép nhiều instance nhưng làm `--style` không dùng được.
- `[verified · medium-high]` **Không có cam kết bit-exact xuyên version/build.** Khóa darktable version/build, module params/XMP, configdir, ICC, output codec/depth, CPU/OpenCL policy; lưu stdout/stderr, exit code và output hash. Nếu style chỉ là look anchor, materialize nó thành XMP/history cụ thể thay vì phụ thuộc database theo tên.

**Vai trò đề xuất:** engine chính cho RAW master và edit local/final scene-referred. Điểm yếu là sinh XMP/module blobs theo version khó hơn PP3 hoặc graph libvips; dùng adapter theo từng darktable version và golden-image conformance tests.

**Nguồn:** darktable official user manual development: `darktable-cli`, scene-referred workflow, masks/drawn/parametric/raster và `external raster mask`; truy cập 2026-07-28.

### 5.5 RawTherapee CLI

- `[verified · high]` **CLI/PP3 là contract tự động hóa rõ nhất cho global RAW edits.** Cú pháp `rawtherapee-cli ... -p recipe.pp3 ... -c input` (bắt buộc `-c` cuối). PP3 là text; có thể nạp nhiều `-p` và sidecar `-s/-S` theo thứ tự, profile sau override profile trước. `-d` luôn là base bất kể vị trí. Đây là primitive tốt để compile `technical.pp3 → intent.pp3 → look.pp3`.
- `[verified · high]` **Partial profile hỗ trợ composition nhưng cần phân biệt mode.** `Preserve` chỉ ghi đè tham số có trong profile; `Fill` đặt tham số thiếu về hard-coded defaults và có thể xóa edit cũ. Neko phải tạo partial profile theo semantics Preserve, không dựa GUI default/dynamic profile, và lưu toàn bộ PP3 thực tế đã merge.
- `[verified · high]` **Output phải khai báo hết.** Mặc định là JPEG quality 92; TIFF/PNG mặc định 16-bit, JPEG luôn 8-bit. `-t -b16` hoặc `-n -b16`, `-Y`, output path và sidecar policy phải explicit. `-O` copy PP3 cạnh output; `-S` bỏ qua ảnh thiếu sidecar, tránh âm thầm render neutral/default.
- `[verified · medium-high]` **Local Adjustments mạnh về nhiếp ảnh nhưng kém auditability cho code generation.** RT-spots ellipse/rectangle chọn vùng theo ΔE từ hue/chroma/luminance quanh reference circle, có graduated/parametric masks và nhiều module exposure/tone/color/CAM16. Tuy nhiên RawPedia không đặc tả schema PP3 cho spot/mask; selection content-aware thay đổi khi dời reference; pipeline position cố định chứ không theo thứ tự thêm. Không nên để v1 tự sinh local PP3 bằng chuỗi key reverse-engineered.
- `[verified · high]` **PP3 không khóa renderer xuyên phiên bản.** RawPedia nói tool defaults/behavior có thể đổi và cùng giá trị có thể render khác; muốn reproduce chính xác cần version, cache/config và profiles tương ứng. Lưu executable hash/version, PP3 merged, output profile/bit-depth và golden-image hash.

**Vai trò đề xuất:** alternative RAW developer và base/global recipe dễ sinh, rất hợp MVP không local; darktable thắng khi cần masks/dodge-burn/local grade có semantics chính thức.

**Nguồn:** RawPedia official “Command-Line Options”, “Sidecar Files – Processing Profiles” và “Local Adjustments” (cập nhật 2025-01-22); truy cập 2026-07-28.

### 5.6 FFmpeg

- `[verified-local · high]` **Binary hiện có đủ global parametric primitives.** `ffmpeg 7.1.1-essentials_build-www.gyan.dev` expose: `exposure` (−3..+3 EV, black −1..1), `eq` brightness/contrast/gamma/RGB gamma/saturation, `curves` (master/R/G/B, PCHIP monotonic), `colorbalance` shadow/midtone/highlight RGB, `colorchannelmixer`, `colortemperature` 1000–40000 K, `selectivecolor`, `lut1d/lut3d`, crop/rotate và `maskedmerge`. Histogram/waveform có thể làm diagnostics.
- `[verified-local · high]` **Color management thiên về video signal.** `colorspace`/`zscale` khai báo và đổi matrix, range, primaries, transfer, bit depth, chromatic adaptation/dither; đây là nền tảng tốt cho BT.709/BT.2020/HDR/video. Nó không phải camera RAW developer hay ICC-centric photo engine ngang darktable/RawTherapee/libvips+LittleCMS.
- `[verified-local · high]` **Local edit làm được nhưng không ergonomic.** Cần tạo ba stream base/edited/mask rồi `maskedmerge`; mỗi stage phải quản pixel format/timebase/framesync. Với một ảnh đơn và nhiều mask nối tiếp, graph dài, escaping Windows và accidental YUV subsampling/range là rủi ro lớn.
- `[verified-local · high]` **Same-build reproducibility đã smoke-test.** Hai lần chạy cùng generated frame, `-threads 1 -bitexact`, float RGB exposure→PCHIP curve→eq→crop→RGB24 cho cùng `framemd5` `8eeb66f614176df72a1f9fb9d788593d`. Đây chỉ xác nhận pipeline cụ thể trên build này; codec, swscale/zimg, hardware, thread, pixfmt và version khác vẫn có thể đổi output.

**Vai trò đề xuất:** engine chính nếu skill mở rộng sang video/timelapse hoặc cần áp một LUT/grade đồng nhất theo frame; không chọn làm engine ảnh RAW/still chính.

**Nguồn:** FFmpeg official filter documentation (trang quá lớn nên web extractor chỉ lấy mục lục); tham số được kiểm chứng trực tiếp bằng `ffmpeg -h filter=<name>` và smoke test local ngày 2026-07-28.

### 5.7 Kết luận lựa chọn engine

1. **Nếu buộc chọn một executable duy nhất cho đề bài:** `darktable-cli` — mạnh nhất về RAW, scene-referred color pipeline, local/drawn/parametric masks, history và ICC. Cái giá là adapter XMP phụ thuộc version.
2. **Kiến trúc tốt nhất:** `darktable-cli` làm RAW master/final local grade + libvips binding làm preview nhanh, metrics, mask algebra và rendered-input pipeline. Đây là phân vai theo thế mạnh, không chạy hai engine chồng cùng phép màu.
3. **RawTherapee CLI:** lựa chọn thực dụng cho v1 global/base RAW vì PP3 text/partial profiles dễ compile; chỉ dùng local khi đã có adapter PP3 được golden-test theo version.
4. **ImageMagick 7:** geometry, mask conversion/composite, diagnostic/fallback; không làm color/RAW spine.
5. **FFmpeg:** video/sequence/LUT parity; không làm still-photo spine.

**Ý nghĩa “deterministic” trong báo cáo:** cùng source hash + recipe/materialized masks + engine/dependency build + color assets + execution policy phải cho output hash ổn định trong conformance matrix. Không engine nào ở đây cung cấp lời hứa bit-identical xuyên version/platform; Neko phải pin và kiểm thử, không chỉ lưu command.

## 6. Cách các sản phẩm AI hiện hành giữ danh tính

### 6.1 Adobe Lightroom

- `[verified · high]` **Lightroom giữ original bằng metadata, không phải bằng identity model.** Local-tab edits là non-destructive metadata; tùy file chúng nằm trong file hoặc XMP sidecar, và phải export mới tạo rendition nhìn được ở app khác. Camera Raw tương tự: giữ raw gốc, lưu WB/tone/color/sharpening vào XMP/database/DNG metadata. Đây là provenance/reversibility, chưa phải bảo đảm khuôn mặt không đổi.
- `[verified · high]` **Auto là ví dụ tốt về ML→tham số.** Adobe Sensei phân tích ảnh rồi đặt các slider Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Saturation và Vibrance; người dùng vẫn sửa từng slider. Neko có thể học pattern này: model đề xuất named parameters, renderer cổ điển thực thi.
- `[verified · high]` **AI Mask là discriminative selection, rồi local parametric edit.** Subject/Sky/Background/People (cả hair/skin/teeth) được phân đoạn; sau đó người dùng Add/Subtract/refine và dùng slider exposure/color/tone. Với ràng buộc đề tài, AI mask được phép nếu materialize raster/vector mask, hash và render không cần chạy lại model.
- `[verified · high]` **Adobe tự tách operation family trong AI Edit Status.** Thứ tự chính thức gồm Enhance/Remove/Lens Blur/Adaptive Profile/global/masking; một số mask/model phải “Update” lại theo nền tảng. Điều này chứng minh nhãn “AI edit” không nói lên safety: từng operation phải có policy riêng.
- `[verified · high]` **Hard deny:** Generative Remove/Expand, Distracting People/Reflection removal, Content-Aware Remove/Heal/Clone vì thay nội dung chứ không chỉ tonal; Neural/Enhance-style detail reconstruction ngoài scope. `Denoise`, `Raw Details`, `Super Resolution`, `Adaptive Profiles`, `Lens Blur` không nhất thiết đổi danh tính, nhưng renderer/model không được materialize thành named tonal recipe và có thể cần recompute—để ngoài deterministic core, chỉ opt-in sau conformance.

**Kết luận:** Lightroom không có một “identity lock” chung. Vùng giữ danh tính đến từ non-destructive original + operation provenance + parametric sliders/masks. Neko phải tái tạo chính vùng đó và từ chối phần còn lại.

### 6.2 Adobe Photoshop parametric/non-generative

- `[verified · high]` **Adjustment Layers** lưu tone/color settings riêng, có Properties và layer mask; không ghi đè source pixels. **Camera Raw Smart Object** cho phép mở lại WB/tone/color; **Smart Filters** có thể sửa/reorder/delete, blend và mask. Đây là mô hình recipe/layer stack tốt cho Neko.
- `[verified · high]` **“Non-destructive” chỉ nói khả năng undo, không nói phép biến đổi an toàn.** Smart Filter có thể bọc nhiều filter tùy ý; layer riêng có thể chứa clone/heal; cả hai vẫn không phá original nhưng rendition đã thay nội dung. Executor phải allowlist operation semantics, không allow chỉ vì nó là Smart Object/layer.
- `[verified · high]` **Hard deny từ chính mô tả Adobe:** Generative Fill add/remove/replace object; Generative Expand mở canvas; Generate Background/Image/Similar và Generative Upscale sinh pixel. Neural Filters có thể thay expression, age, gaze, hair thickness/head direction và tài liệu gọi chúng là generative; tất cả vi phạm identity constraint.
- `[verified · high]` **Safe subset:** Curves/Levels/Color Balance/Hue-Saturation/Selective Color/Black & White/Photo Filter/Gradient Map (nếu dùng như color mapping), Camera Raw tonal/HSL/color grading, crop/rotate/perspective, và mask chỉ điều khiển opacity của các phép trên. Smart Sharpen/blur/texture cần bounds riêng; không nằm core tonal v1.

**Kết luận:** Photoshop đưa ra mô hình lớp/mask/reversible recipe tốt, nhưng product surface quá rộng để coi toàn bộ là identity-preserving.

### 6.3 Google Photos

- `[verified · high]` **Google bảo vệ khả năng quay lại bản gốc, không bảo vệ danh tính của mọi edit.** `Save as copy` giữ original; `Save` có thể áp vào original nhưng `Edit → Revert` phục hồi; giữ preview để so before/after. Với Neko, luôn tương đương `Save as copy`, không overwrite source.
- `[verified · high]` **Safe subset có thể ánh xạ:** crop/straighten/rotate/perspective/mirror; Brightness/Contrast/Saturation/Warmth/Shadows; classic filters nếu biết/khóa transfer function. Portrait Light cho đặt vị trí/độ sáng ánh sáng và Blur/Depth/Color Focus/Sky là local effect hợp ý tưởng, nhưng Google không công bố recipe/mask—chỉ là UX reference, không dùng làm deterministic backend.
- `[verified · high]` **Hard deny:** Magic Eraser/Erase bỏ object; Move cần tái dựng nền; Auto Frame có thể mở rộng và fill; Magic Editor dùng generative AI để reposition subject/thay sky; conversational Gemini có ví dụ remove cars, change background, add party hat/glasses. Photo Remix/Reimagine/Video Remix/Zoom Enhance/Unblur có thể sinh hoặc suy đoán detail; ngoài core.
- `[verified · high]` **C2PA/IPTC/SynthID là transparency, không phải identity guarantee.** Google Photos hiển thị Content Credentials, IPTC cho AI-edited images và SynthID cho Reimagine. Chúng giúp biết provenance sau khi edit, nhưng không ngăn model thay khuôn mặt/chủ thể và không thay recipe-level allowlist.
- `[verified · medium-high]` **Nhãn “Enhance/AI-powered” không đủ chi tiết.** Help page không công bố các tham số hay xác nhận thao tác nào generative. Nếu một product không export được named recipe/masks/build, Neko phải coi đó là opaque và không dùng trong deterministic executor.

### 6.4 Ranh giới parametric, discriminative ML và generative AI

| Lớp | Ví dụ | Chính sách Neko |
|---|---|---|
| Parametric/geometric | EV, WB, monotonic curves, HSL, CDL, crop/rotate/perspective, fixed LUT | **Cho phép** với bounds, color-space và recipe rõ |
| Discriminative AI | detect subject/person/sky, classify WB cast, aesthetic critique | **Cho phép ở planner/masker**; materialize output, model không render pixel |
| Learned but compiled photometric | fixed 3D LUT, affine bilateral grid, vector/raster mask | **Optional** nếu geometry giữ nguyên, seed/version cố định, asset hash và verifier pass |
| Opaque adaptive renderer | Adaptive Profile, Portrait Light, Denoise/SR/Unblur | **Không ở core**; chỉ opt-in sau benchmark và materialization/conformance |
| Content synthesis/removal | inpaint, gen fill/expand, move/add/remove/replace, face/body reshape | **Cấm cứng** |

## 7. Nguyên tắc chống “AI slop” và kiểm định

1. **Identity by construction trước identity by score:** executor không expose tool nào có thể add/remove/repaint/warp chủ thể. Metric chỉ phát hiện bug/regression; không hợp pháp hóa operation bị cấm.
2. **Model không chạm pixel:** VLM chỉ trả diagnosis, intent, vùng và structured parameters. Mọi pixel do engine tham số đã pin thực thi.
3. **Mọi local edit có mask hữu hình:** raster/vector mask được lưu, hash, overlay trong contact sheet và có thể sửa; không có “semantic brush” chạy lại âm thầm lúc final render.
4. **Original immutable:** source hash bất biến; mọi preview/final là derivative; recipe có undo/diff. Không có save-in-place.
5. **Color pipeline đóng:** input/working/output profile, transfer, bit depth, LUT domain/interpolation và display transform phải explicit; không hai display transforms.
6. **Bounded deltas:** planner chọn bước nhỏ theo stop/slider bounds, giữ tham số không được nhắc, chỉ commit candidate tốt hơn và giới hạn vòng lặp.
7. **Protected-region verifier:** sau khi map crop/rotation về tọa độ gốc, kiểm geometry/landmarks/edge/segmentation overlap; tách skin-tone ΔE/chroma, clipping, gamut và texture drift. VLM aesthetic score không tự chấm safety.
8. **Provenance hoàn chỉnh:** source/recipe/mask/profile/LUT/engine/output hashes, argv/exit/stderr, model/version/prompt và từng preview score. C2PA là lớp xuất bản bổ sung, không thay log nội bộ.
9. **Human veto:** before/after, mask overlay, histogram/vectorscope, recipe diff và nút chỉnh/khóa từng operation trước final high-res.

## 8. Thiết kế đề xuất cho skill Neko

### 8.1 Quyết định kiến trúc

**Tên working:** `pro-photo-grade` — skill chuyên *develop/grade*, không phải image editor tổng quát.

```text
source immutable
  → ingest + color/EXIF manifest
  → deterministic measurements
  → VLM diagnosis/intent (không pixel, không CLI)
  → typed recipe compiler + numeric solver
  → materialize masks/assets
  → policy validation
  → same-engine preview candidates
  → metrics + VLM critique + user locks
  → improve-only commit / bounded iteration
  → full-res render + independent verification
  → final derivative + recipe + provenance report
```

Phân tách bốn thành phần bắt buộc:

1. **Planner VLM:** nhìn preview, mô tả ý đồ/thứ tự và chọn operation từ enum; không sinh command, curve blob tùy ý hay pixel.
2. **Numeric compiler:** đổi diagnosis thành bước số có bounds; ví dụ VLM chỉ phân loại WB cast, solver tìm illuminant/temperature-tint như VLM-CC.
3. **Deterministic executor:** chỉ nhận typed recipe đã validate; không có generic `shell`, free-form filtergraph hoặc plugin tùy ý.
4. **Verifier độc lập:** đọc source/recipe/masks/output; policy/geometry/signal checks không dùng reasoning của planner.

### 8.2 Engine routing

| Input/nhu cầu | Preview và final | Vai trò phụ |
|---|---|---|
| Camera RAW, cần local grade | **darktable-cli cùng XMP/pixelpipe** ở kích thước preview và full-res | libvips làm thumbnail, mask/metrics/contact sheet |
| Camera RAW, global MVP | RawTherapee CLI với merged PP3 16-bit | libvips diagnostics/output conversion |
| TIFF/PNG/JPEG rendered | **Một graph libvips** cho cả preview và final | ImageMagick khi cần geometry/mask format chưa có binding |
| Video/timelapse | FFmpeg filtergraph/LUT đã khóa | libvips cho keyframe analysis |

Không render preview bằng libvips rồi final bằng darktable cho cùng một recipe: khác transfer/module semantics có thể làm VLM duyệt một ảnh nhưng xuất ảnh khác. Preview là cùng engine, chỉ đổi resolution/output encoding.

### 8.3 Recipe contract

```json
{
  "schema_version": "1.0",
  "source": {"sha256": "…", "path": "…", "orientation": 1},
  "intent": {"genre": "portrait", "target": "natural editorial", "protected": ["subject", "skin"]},
  "color": {
    "input_profile_sha256": "…",
    "working_space": "engine-native-scene-referred",
    "display_transform": "sigmoid",
    "output_profile_sha256": "…",
    "bit_depth": 16
  },
  "engine": {"name": "darktable-cli", "version": "…", "build_sha256": "…", "opencl": false},
  "operations": [
    {"id": "op01", "stage": "technical", "type": "exposure", "params": {"ev": 0.35}, "bounds": {"ev": [-2, 2]}, "mask": null, "locked": false, "reason": "place mid-gray"}
  ],
  "masks": [{"id": "m01", "kind": "raster", "sha256": "…", "source_space": "raw-sensor", "orientation": 1}],
  "look_assets": [{"path": "…", "sha256": "…", "input_space": "…", "output_space": "…", "interpolation": "tetrahedral"}],
  "execution": {"threads": 1, "random_seed": null, "rounding": "engine-default-pinned"}
}
```

**Allowlist v1:** orientation/lens profile/CA; crop/rotate/straighten/perspective; WB illuminant hoặc temperature/tint; exposure EV; black/white relative exposure; **một** display transform (`filmic` hoặc `sigmoid`, không cả hai); monotonic tone/RGB curves; contrast/pivot; HSL/color mixer; saturation/vibrance; CDL/lift-gamma-gain; vignette; fixed LUT/CMT/film-print emulation; local exposure/WB/contrast/saturation/color grade qua vector/raster/luma/chroma/hue mask; deterministic grain với fixed seed và bounds.

**Denylist compile-time:** mọi tên chứa/ánh xạ tới generate/inpaint/fill/expand/erase/remove/replace/move subject/background/face/body/beauty/reshape/neural portrait/super-resolution/restore hallucinated detail; generic script/plugin/filter; crop ngoài source canvas; non-affine subject warp; unpinned downloaded model/LUT/profile.

Curve phải có `x` tăng, `y` không giảm trừ khi recipe được người dùng mở khóa rõ; LUT phải có domain/profile/hash. Grain bị tắt ở protected skin mặc định hoặc giới hạn sau calibration.

### 8.4 Vòng lặp agentic

1. **Ingest:** hash source; đọc EXIF/lens/orientation/embedded ICC; copy vào job read-only; tạo manifest. RAW clipping được đo trước display transform.
2. **Measure:** histogram/percentiles theo luminance, RGB channel clipping, neutral candidates, dominant cast, horizon/verticals, face/subject/skin masks và sharp/noise diagnostics. Detection chỉ tạo metadata/mask, không sửa ảnh.
3. **Previsualize:** VLM trả `intent`, tonal zones, protected regions, crop rationale và ordered change list. Nó phải nói rõ “không cần chỉnh” khi baseline đã đạt.
4. **Compile:** numeric solver bắt đầu từ neutral/current recipe; mỗi vòng chỉ đổi 1–3 dimensions bằng delta nhỏ. Tham số không được nhắc giữ nguyên—pattern của IEA/RetouchAgent.
5. **Preview search:** render baseline + 3–5 bounded candidates bằng cùng engine; giữ top-K từ hard metrics và critique, rồi full-resolution recheck candidate thắng nếu local texture/gamut có thể đổi—mượn preview-search của PhotoAgent nhưng bỏ toàn bộ generative actions.
6. **Reflect:** VLM so contact sheet, histogram/vectorscope, mask overlay và diff recipe; output phải là `accept | revise | stop`, lý do và đúng parameters được phép đổi.
7. **Commit:** chỉ nhận candidate không có hard failure và tốt hơn baseline theo tiêu chí ưu tiên; lưu full history, không overwrite recipe trước.
8. **Stop:** tối đa 3 vòng mặc định/5 vòng hard cap; dừng khi VLM `stop`, hai vòng không cải thiện, delta dưới epsilon đã calibration, hoặc user lock/accept. Không tối ưu vô hạn tới một aesthetic score.

### 8.5 Verifier và failure policy

**Gate trước render:** JSON Schema; enum allowlist; path trong job; file/hash/version/profile có mặt; curve/LUT/mask/color order hợp lệ; không hai display transforms; source chưa đổi.

**Gate sau render:**

- Map output về source coordinates bằng affine/crop transform trước khi so; chỉ đánh giá vùng overlap.
- Protected subject: landmark distances, segmentation IoU/contour, edge map và structure similarity sau khi loại ảnh hưởng tone; face embedding chỉ là một cảnh báo bổ sung, không phải identity proof.
- Color/tone: channel clipping, highlight/shadow occupancy, out-of-gamut, neutral/skin hue-chroma/ΔE drift, local halo/banding, noise/texture drift.
- Recipe/render: mask coverage/feather, operation diff, output profile/bit depth/metadata; render lặp trong CI/golden suite phải cho hash kỳ vọng trên pinned build.
- Aesthetic: VLM/human chấm intent, composition, zone placement và consistency; không được override hard failure.

Không đặt threshold “chuẩn” từ suy đoán. Calibrate theo FiveK/PPR10K + bộ RAW nội bộ có chân dung, landscape, low/high key, mixed light và nhiều skin tone; báo ROC/failure tail rồi version hóa threshold theo engine/camera class.

### 8.6 Job artifact và provenance

```text
job/
  source/immutable-original
  manifest.json
  recipe.v1.json
  engine-materialized/edit.xmp | edit.pp3
  masks/*.png|*.pfm + masks.json
  previews/round-*/candidate-*.*
  reports/measurements.json
  reports/verification.json
  final/<source-stem>.tif|jpg
  provenance.json
```

`provenance.json` giữ source/recipe/mask/profile/LUT/engine/output hash, model ID/prompt hash, commands dưới dạng argv array, environment, exit code/stderr và history candidate. C2PA Content Credentials là optional export layer; internal manifest vẫn là nguồn audit chính.

### 8.7 Windows execution

- Dùng `spawn(exe, argv[])`, không dựng command string; đường dẫn có dấu cách không qua shell quoting.
- Mỗi job có temp/output riêng; validate resolved path ở workspace; source mở read-only; final dùng tên mới.
- Kiểm exit code và stderr; xóa output dở khi command fail; atomic rename sau verification.
- Pin binary/dependency bundle và hash ICC/LUT. Với darktable, configdir cô lập, XMP explicit, format options explicit, tắt custom presets DB nếu không dùng style; với RawTherapee, `-c` cuối và PP3 merge materialized.
- Log text CLI giữ ASCII-safe vì Windows console của Neko có thể dùng code page không-UTF-8.

### 8.8 Lộ trình triển khai

1. **MVP-A rendered RGB:** libvips JSON→graph; global tone/color/geometry + vector/raster masks; verifier/provenance đầy đủ.
2. **MVP-B RAW global:** RawTherapee PP3 compiler vì contract text dễ test; 16-bit TIFF intermediate.
3. **Pro RAW/local:** darktable XMP adapter theo version, external/drawn/parametric mask và same-engine preview/final.
4. **Learned optional:** chỉ thêm fixed LUT/ICELUT hoặc serialized bilateral grid sau khi seed/build/asset được khóa và benchmark identity/structure pass; không mặc định.
5. **Batch/colorist mode:** shot/group balance, reference still, shared look layer và per-image correction; đo PPR10K-style group consistency.

### 8.9 Definition of done cho một edit

- Source hash còn nguyên; output là derivative.
- Recipe chỉ có operation allowlist; mọi local edit có mask đã materialize/hash.
- Color pipeline và engine version/build đầy đủ; không dùng hidden GUI/default DB.
- Hard verifier không fail; warnings/metric và VLM critique có trong report.
- Final render tái tạo được trên supported pinned bundle; golden conformance pass.
- Người dùng thấy before/after, mask overlay, recipe diff và có thể undo/lock/approve.

## 9. Khoảng trống, phản chứng và câu hỏi mở

- `[refuted · high]` **“Content/identity-preserving” trong abstract hoặc CLIP score không đủ.** PhotoAgent cho phép generative object/background edits dù có content-preservation prompt và CLIP similarity; vì vậy nhãn này không chứng minh ràng buộc đề tài. Tiêu chuẩn chấp nhận phải xét operation provenance + hard allowlist + structure/identity checks, không xét tên paper.
- [open] Cần xác định threshold thực nghiệm cho landmark/edge/segmentation drift mà không báo động giả khi crop/rotate và local tonal edit.
- [open] Tính deterministic của engine không bảo đảm output bit-exact nếu khác phiên bản, thread scheduling, codec, color profile hoặc hardware acceleration.
- [open] VLM có thể đánh giá thẩm mỹ nhưng không đáng tin để tự xác nhận không thay danh tính; cần kiểm định ảnh/recipe độc lập.

## 10. Nguồn gốc đã đọc

Tất cả truy cập ngày 2026-07-28 trừ khi ghi khác. Link là paper/project/manual/trang hãng gốc, không link trang kết quả tìm kiếm.

### 10.1 Nhiếp ảnh và color grading

- Center for Creative Photography — [Intimate Nature: Ansel Adams and the Close View](https://ccp.arizona.edu/learn/educators-guides-archive/intimate-nature-ansel-adams-and-close-view/); Smithsonian — [Zone System Manual catalog record](https://www.si.edu/object/zone-system-manual-previsualization-exposure-development-printing-ansel-adams-zone-system-basis%3Asiris_sil_259476).
- Ira H. Latour — [Ansel Adams, the zone system and the California School of Fine Arts](https://www.tandfonline.com/doi/abs/10.1080/03087298.1998.10443870), *History of Photography* 22(2), 1998.
- FilmLight — [Base Grade and the evolution of grading tools](https://www.filmlight.ltd.uk/store/news_articles/lowepost-base-grade-and-the-evolution-of-grading-tools/) (2017-04-12); [Meet the Colourist: Aljoscha Hoffmann](https://www.filmlight.ltd.uk/customers/meet-the-colourist/aljoscha_hoffmann.php).
- ARRI — [What is an ARRI Look File?](https://www.arri.com/en/learn-help/learn-help-camera-system/image-science/look-files).
- Blackmagic Design — [DaVinci Resolve: Color](https://www.blackmagicdesign.com/products/davinciresolve/color).

### 10.2 Paper, dataset và benchmark

- Dutt et al. — [MonetGPT project](https://monetgpt.github.io/), SIGGRAPH/TOG 2025.
- Lin et al. — [JarvisArt official NeurIPS proceedings](https://papers.neurips.cc/paper_files/paper/2025/hash/4ac4365b98bc242acd5ab974a05c68a8-Abstract-Conference.html), 2025.
- Wu et al. — [RetouchIQ CVF page](https://openaccess.thecvf.com/content/CVPR2026/html/Wu_RetouchIQ_MLLM_Agents_for_Instruction-Based_Image_Retouching_with_Generalist_Reward_CVPR_2026_paper.html) và [arXiv HTML](https://arxiv.org/html/2602.17558), CVPR 2026.
- Zhang & Yang — [RetouchAgent AAAI article](https://ojs.aaai.org/index.php/AAAI/article/view/40237) và [paper PDF](https://ojs.aaai.org/index.php/AAAI/article/download/40237/44198), AAAI 2026.
- Yao et al. — [PhotoAgent arXiv HTML](https://arxiv.org/html/2602.22809), ICML 2026.
- Guo et al. — [LumiVideo arXiv HTML](https://arxiv.org/html/2604.02409), 2026.
- Li et al. — [VLM-CC CVF page](https://openaccess.thecvf.com/content/CVPR2026/html/Li_White-Balance_First_Adjust_Later_Cross-Camera_Color_Constancy_via_Vision-Language_Evaluation_CVPR_2026_paper.html) và [arXiv HTML](https://arxiv.org/html/2605.19613), CVPR 2026.
- Chen et al. — [PhotoArtAgent](https://arxiv.org/abs/2505.23130), 2025.
- Zhu et al. — [IEA arXiv HTML](https://arxiv.org/html/2606.08016v1), CVPR Findings 2026.
- Wu et al. — [InstantRetouch arXiv HTML](https://arxiv.org/html/2606.05071), CVPR 2026.
- Guo et al. — [VeraRetouch arXiv HTML](https://arxiv.org/html/2604.27375), 2026.
- Liu et al. — [MirrorPPR](https://arxiv.org/abs/2606.29308), ECCV 2026.
- MIT CSAIL — [MIT-Adobe FiveK dataset](https://data.csail.mit.edu/graphics/fivek/).
- Hu et al. — [Exposure arXiv API record](https://export.arxiv.org/api/query?id_list=1709.09602), SIGGRAPH/TOG 2018. PDF gốc timeout trong lượt này.
- Moran et al. — [DeepLPF CVF page](https://openaccess.thecvf.com/content_CVPR_2020/html/Moran_DeepLPF_Deep_Local_Parametric_Filters_for_Image_Enhancement_CVPR_2020_paper.html), CVPR 2020.
- Liang et al. — [PPR10K CVF page](https://openaccess.thecvf.com/content/CVPR2021/html/Liang_PPR10K_A_Large-Scale_Portrait_Photo_Retouching_Dataset_With_Human-Region_Mask_CVPR_2021_paper.html), CVPR 2021.
- Ouyang et al. — [RSFNet CVF page](https://openaccess.thecvf.com/content/ICCV2023/html/Ouyang_RSFNet_A_White-Box_Image_Retouching_Approach_using_Region-Specific_Color_Filters_ICCV_2023_paper.html), ICCV 2023.
- Yang et al. — [ICELUT ECCV poster](https://eccv.ecva.net/virtual/2024/poster/703), ECCV 2024.
- Zhang et al. — [LLF-LUT++ arXiv HTML](https://arxiv.org/html/2510.11613), 2025.
- Rota et al. — [C²LUT](https://arxiv.org/abs/2607.11681), 2026-07-14.
- Elezabi et al. — [Photography Retouching Transfer, NTIRE 2026 Challenge](https://openaccess.thecvf.com/content/CVPR2026W/NTIRE/html/Elezabi_Photography_Retouching_Transfer_NTIRE_2026_Challenge_Report_CVPRW_2026_paper.html), CVPRW 2026.

### 10.3 CLI và color pipeline

- ImageMagick — [Command-line Options](https://imagemagick.org/command-line-options/); [Color Management](https://imagemagick.org/color-management/).
- libvips — [official homepage](https://www.libvips.org/); [Windows install](https://www.libvips.org/install.html); [How it works](https://www.libvips.org/API/8.16/How-it-works.html); [Colour API](https://www.libvips.org/API/current/libvips-colour.html).
- darktable — [`darktable-cli`](https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/); [scene-referred workflow](https://docs.darktable.org/usermanual/development/en/overview/workflow/process/); [mask overview](https://docs.darktable.org/usermanual/development/en/darkroom/masking-and-blending/masks/overview/); [drawn](https://docs.darktable.org/usermanual/development/en/darkroom/masking-and-blending/masks/drawn/), [parametric](https://docs.darktable.org/usermanual/development/en/darkroom/masking-and-blending/masks/parametric/), [raster](https://docs.darktable.org/usermanual/development/en/darkroom/masking-and-blending/masks/raster/) và [external raster mask](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/external-raster/).
- RawTherapee/RawPedia — [Command-Line Options](https://rawpedia.rawtherapee.com/Command-Line_Options); [Sidecar Files – Processing Profiles](https://rawpedia.rawtherapee.com/Sidecar_Files_-_Processing_Profiles); [Local Adjustments](https://rawpedia.rawtherapee.com/Local_Adjustments).
- FFmpeg — [official filter documentation](https://ffmpeg.org/ffmpeg-filters.html); do trang quá lớn, filter facts còn được xác nhận bằng `ffmpeg 7.1.1 -h filter=<name>` trên máy nghiên cứu.

### 10.4 Adobe và Google

- Adobe Lightroom — [Local non-destructive editing/XMP](https://helpx.adobe.com/lightroom-cc/using/access-photos.html); [Auto settings](https://helpx.adobe.com/uk/lightroom/mobile/adjust-light-and-color/apply-auto-settings.html); [Masking](https://helpx.adobe.com/lightroom/desktop/edit-photos/masking.html); [Camera Raw masking](https://helpx.adobe.com/uk/camera-raw/using/masking.html); [Manage AI Edits](https://helpx.adobe.com/ca/lightroom-cc/web/share-your-work/review-and-download/manage-ai-edits.html); [Adaptive Profiles](https://helpx.adobe.com/lightroom/web/edit-photos/apply-effects/use-adaptive-profiles.html); [Enhance](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/enhance-details.html).
- Adobe Camera Raw — [Introduction to Camera Raw](https://helpx.adobe.com/camera-raw/using/introduction-camera-raw.html); [2026 release notes](https://helpx.adobe.com/camera-raw/using/whats-new/release-notes.html).
- Adobe Photoshop — [Adjustment Layers](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/color-adjustment-fill-layers/create-adjustment-layers.html); [Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html); [Non-destructive editing](https://helpx.adobe.com/photoshop/using/nondestructive-editing.html); [Generative AI features](https://helpx.adobe.com/photoshop/desktop/generative-ai/generative-ai-features-overview.html); [Neural Filters overview](https://helpx.adobe.com/photoshop/desktop/effects-filters/neural-filters/overview-of-neural-filters.html).
- Google Photos Help — [Edit your photos](https://support.google.com/photos/answer/6128850?co=GENIE.Platform%3DAndroid&hl=en); [Pixel photo editing](https://support.google.com/photos/answer/9940184?hl=en); [Use AI to create](https://support.google.com/photos/answer/16763021?hl=en).
- Google Blog — [AI editing tools availability](https://blog.google/products-and-platforms/products/photos/google-photos-editing-features-availability/) (2024-04-10); [Edit images by asking](https://blog.google/products-and-platforms/products/photos/ai-photo-editing-google-photos/) (2025-08-20); [C2PA and trusted images](https://blog.google/security/pixel-android-trusted-images-c2pa-content-credentials/) (2025-09-10); [Tools to understand content provenance](https://blog.google/innovation-and-ai/products/identifying-ai-generated-media-online/) (2026-05-19).

### 10.5 Ghi chú truy xuất

- Đã dùng cả `web_search` và `web_fetch` theo yêu cầu. Backend SearXNG cục bộ không kết nối được trong một số truy vấn và DuckDuckGo fallback trả rỗng; khi đó dùng search engine tích hợp khác để tìm URL rồi đọc trang hãng/paper gốc.
- `web_fetch` đọc trực tiếp được paper/CVF/arXiv, darktable, RawPedia, Google và các manual nhỏ. Một số Adobe Help page timeout ở `web_fetch`; nội dung được đọc từ kết quả mở trang gốc của search engine, và URL gốc được liệt kê trên.
- FFmpeg HTML bị cắt ở mục lục; tham số được kiểm qua chính binary `-h filter=` và output bằng repeated `framemd5`. Không suy các option không xuất hiện trong help local.

## 11. Nhật ký cập nhật

- **2026-07-28 — Khởi tạo:** tạo khung mục lục, khóa phạm vi non-generative và tiêu chí đánh giá trước khi tìm nguồn.
- **2026-07-28 — Workflow nghề nghiệp:** thêm Zone System, Base Grade/Resolve, ARRI Look File và triết lý show LUT.
- **2026-07-28 — Paper ledger:** thêm white-box/parametric lineage, VLM/LLM agents, compiled photometric methods, datasets/metrics, phản chứng MirrorPPR và cutoff C²LUT 2026-07-14.
- **2026-07-28 — CLI:** thêm ma trận ImageMagick/libvips/darktable/RawTherapee/FFmpeg, local binary inventory và repeated FFmpeg framemd5.
- **2026-07-28 — Product boundary:** phân loại Lightroom/Camera Raw, Photoshop và Google Photos theo parametric/mask/opaque/generative; provenance không được coi là identity guarantee.
- **2026-07-28 — Tổng hợp:** hoàn thiện thiết kế `pro-photo-grade`, recipe contract, engine routing, bounded preview loop, verifier, Windows execution và Definition of Done.

# Chỉnh sửa ảnh chuẩn nhiếp ảnh gia cho AI agent — SOTA đến 2026-07-28

> Trạng thái: đang nghiên cứu · Hạn chót kiến thức: 2026-07-28  
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
| darktable-cli | RAW non-destructive pipeline | TBD | TBD | TBD | TBD | TBD |
| RawTherapee CLI | RAW profile pipeline | TBD | TBD | TBD | TBD | TBD |
| FFmpeg filters | Video/frame filter graph | TBD | TBD | TBD | TBD | TBD |

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

_Đang đọc tài liệu chính thức._

### 5.5 RawTherapee CLI

_Đang đọc tài liệu chính thức._

### 5.6 FFmpeg

_Đang đọc tài liệu chính thức._

### 5.7 Kết luận lựa chọn engine

_Chưa kết luận trước khi kiểm chứng._

## 6. Cách các sản phẩm AI hiện hành giữ danh tính

### 6.1 Adobe Lightroom

_Đang đọc tài liệu chính thức._

### 6.2 Adobe Photoshop parametric/non-generative

_Đang đọc tài liệu chính thức._

### 6.3 Google Photos

_Đang đọc tài liệu chính thức._

### 6.4 Ranh giới parametric, discriminative ML và generative AI

_Đang kiểm chứng._

## 7. Nguyên tắc chống “AI slop” và kiểm định

_Đang xây dựng từ bằng chứng._

## 8. Thiết kế đề xuất cho skill Neko

_Đề xuất cuối sẽ mô tả cụ thể pipeline, schema recipe, planner VLM, engine, preview/render, guardrail, verifier và điều kiện dừng._

## 9. Khoảng trống, phản chứng và câu hỏi mở

- `[refuted · high]` **“Content/identity-preserving” trong abstract hoặc CLIP score không đủ.** PhotoAgent cho phép generative object/background edits dù có content-preservation prompt và CLIP similarity; vì vậy nhãn này không chứng minh ràng buộc đề tài. Tiêu chuẩn chấp nhận phải xét operation provenance + hard allowlist + structure/identity checks, không xét tên paper.
- [open] Cần xác định threshold thực nghiệm cho landmark/edge/segmentation drift mà không báo động giả khi crop/rotate và local tonal edit.
- [open] Tính deterministic của engine không bảo đảm output bit-exact nếu khác phiên bản, thread scheduling, codec, color profile hoặc hardware acceleration.
- [open] VLM có thể đánh giá thẩm mỹ nhưng không đáng tin để tự xác nhận không thay danh tính; cần kiểm định ảnh/recipe độc lập.

## 10. Nguồn gốc đã đọc

_Chưa có — chưa thực hiện truy vấn web trước khi tạo khung._

## 11. Nhật ký cập nhật

- **2026-07-28 — Khởi tạo:** tạo khung mục lục, khóa phạm vi non-generative và tiêu chí đánh giá trước khi tìm nguồn.

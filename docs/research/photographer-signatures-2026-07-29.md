# Chữ ký nhiếp ảnh gia và trường phái: mắt phê bình cho AI photo editor

**Ngày nghiên cứu:** 2026-07-29

**Phạm vi kiến thức:** nguồn công khai kiểm tra đến 2026-07-29

**Trạng thái:** hoàn tất bản 1.0, đã kiểm toán cấu trúc và liên kết ngày 2026-07-29

**Mục tiêu:** chuyển lịch sử nhiếp ảnh, ngôn ngữ ánh sáng, màu và bố cục thành tiêu chí quan sát được để VLM phân tích ảnh trước khi một pipeline chỉnh ảnh tham số ra quyết định.

## Quy ước bằng chứng

- `[verified]`: claim cốt lõi đã được đối chiếu qua ít nhất hai nguồn độc lập, ưu tiên nguồn sơ cấp/bảo tàng/hiệp hội nghề nghiệp.
- `[supported]`: có một nguồn tốt hoặc nhiều nguồn thứ cấp nhất quán, nhưng chưa đủ hai nguồn độc lập cho toàn bộ claim.
- `[inference]`: diễn giải sư phạm hoặc quy tắc vận hành do nghiên cứu này tổng hợp; không phải câu nói nguyên văn của nghệ sĩ.
- `[open]`: cần kiểm chứng thêm hoặc thuật ngữ thị trường chưa có định nghĩa học thuật ổn định.
- Mọi nguồn ghi **ngày xuất bản/cập nhật** nếu trang công bố; nếu không có thì ghi `n.d.`. `Truy cập` là ngày Neko đọc nguồn, không phải ngày xuất bản.
- “Chữ ký” ở đây là cụm đặc điểm thường gặp trong một phần quan trọng của oeuvre, không phải preset áp cho mọi tác phẩm. Không suy tên tác giả chỉ từ phong cách.

## Ledger phát hiện

### 1. Pattern ánh sáng chân dung kinh điển

#### 1.1. Tiên đề: đọc bóng trước, gọi tên sau

- `[verified · confidence: high]` Trong nghề chân dung, “lighting pattern” trước hết mô tả **bóng đổ trên khuôn mặt trong quan hệ giữa đầu người mẫu và nguồn sáng**, không phải loại đèn hay vị trí máy ảnh. Vì vậy cùng một pattern có thể được tạo bằng flash, mặt trời, cửa sổ hoặc phản quang. PPA nói thẳng “what’s being described is where the shadows fall”; Westcott cũng dạy nhận pattern bằng bóng mũi và catchlight. Nguồn: John Gress/PPA, *9 Types of Portrait Lighting*, **2023-10**; Westcott University, *4 Essential Portrait Lighting Patterns*, **n.d.**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
  - https://westcottu.com/4-essential-portrait-lighting-patterns
- `[verified · confidence: high]` **Pattern** và **quality** là hai trục khác nhau. Kích thước biểu kiến của nguồn so với chủ thể quyết định biên bóng cứng/mềm; nguồn nhỏ/xa tạo chuyển tiếp gắt, nguồn lớn/gần tạo chuyển tiếp êm. Do đó “Rembrandt” có thể mềm hoặc cứng; “butterfly” không tự động đồng nghĩa beauty-soft. Nguồn: PPA Certification Guide, *Properties and Quality of Light*, **n.d.**; Mark Bryant/PPA, *To Be a Better Photographer, Get to Know Light*, **n.d.**; truy cập **2026-07-29**.
  - https://wiki.ppa.com/books/photography-certification-guide/page/module-2b-properties-and-quality-of-light
  - https://www.ppa.com/ppmag/articles/to-be-a-better-photographer-get-to-know-light
- `[inference · confidence: high · 2026-07-29]` VLM phải mô tả bốn biến độc lập trước khi phán mood: **hướng** (bóng nằm đâu), **độ cao** (bóng mũi đi xuống bao xa/catchlight còn không), **độ cứng** (biên bóng), **tỉ lệ sáng:tối** (shadow còn chi tiết hay chìm). Gọi pattern chỉ sau đó.

#### 1.2. Năm pattern cốt lõi

| Pattern | Dấu hiệu quan sát được | Khi hợp với ý đồ | Cảnh báo/phản ví dụ |
|---|---|---|---|
| **Loop** | Key ở phía trước và cao hơn mắt, thường lệch khoảng 30–45°; bóng mũi ngắn chạy chéo xuống má nhưng **không nối** với bóng má; phần lớn khuôn mặt vẫn sáng. | Điểm khởi đầu an toàn cho headshot, chân dung thân thiện, thương mại hoặc ảnh cần khối mặt vừa đủ mà không quá kịch. | Bóng mũi chạm bóng má thì đã tiến về Rembrandt; key quá cao làm hốc mắt tối. Không gọi “loop” chỉ vì thấy một má hơi tối. |
| **Rembrandt** | Key cao và lệch bên hơn loop; bóng mũi nối với bóng má, để lại tam giác sáng nhỏ dưới mắt ở phía tối. | Chân dung nhân vật, nội tâm, editorial hoặc ý đồ có trọng lượng; dùng khi muốn mặt có cấu trúc và chiaroscuro. | Tam giác phải do hình học ánh sáng, không phải vùng da được dodge. Không mặc định “nam tính”, “cao cấp” hay low-key; chất lượng và tỉ lệ sáng mới quyết định độ gắt. |
| **Split** | Key gần 90° bên hông; đường sáng/tối chia khuôn mặt gần giữa, một nửa sáng và một nửa tối. | Căng thẳng, đối cực, sức mạnh, poster hoặc chân dung nhạc sĩ/nghệ sĩ cần kịch tính rõ. | Thường kém “forgiving”, dễ nhấn texture và mất mắt phía tối. Không dùng mặc định cho brief vui, cởi mở hay “thơ mộng”. |
| **Butterfly / Paramount** | Key cao, gần trục máy–mặt; bóng nhỏ đối xứng ngay dưới mũi, lý tưởng không kéo quá dài tới môi; hai má/cheekbone sáng cân. | Beauty, fashion, chân dung đối xứng hoặc khi muốn nhấn gò má và tạo cảm giác polished. Thêm reflector/fill dưới cằm thành **clamshell** để hạ contrast. | Key quá cao làm hốc mắt đen/mất catchlight; butterfly trần có thể tạo bóng dưới mắt/cằm. Claim “làm mịn da” chủ yếu phụ thuộc nguồn lớn/mềm và fill, không phải tên pattern. |
| **Backlight / rim** | Nguồn nằm sau chủ thể. Khi ánh sáng chỉ viền quanh tóc/vai/cơ thể, kết quả là **rim**; khi nguồn đi vào ống kính hoặc làm nền sáng, đó vẫn là backlight dù không có viền sạch. | Tách tóc/áo khỏi nền tối, tạo silhouette, glow hoặc cảm giác ngược sáng thoáng/airy. Rim mảnh hợp separation; backlight nở rộng hợp bloom/romantic. | Không có fill/reflector thì mặt có thể thiếu sáng; flare làm giảm contrast; tóc/viền dễ clipping. Không đồng nhất mọi backlight với rim. |

**Bằng chứng cho bảng:**

- `[verified · confidence: high]` Loop: PPA đặt key ngay trên mắt ở khoảng 5 hoặc 7 giờ và mô tả bóng mũi nhẹ; Westcott đặt gần 45°; Nikon gọi đó là bóng dạng loop dưới mũi và “flattering for many types of faces”. Nguồn: PPA **2023-10**; Westcott **n.d.**; Nikon Photography Glossary **n.d.**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
  - https://westcottu.com/4-essential-portrait-lighting-patterns
  - https://www.nikonusa.com/learn-and-explore/photography-glossary/g/1/focal-length-multiplier.html
- `[verified · confidence: high]` Rembrandt: PPA và Profoto cùng xác định tam giác sáng ở má phía tối, hình thành khi bóng mũi nối bóng má; Nikon gọi vùng đó là diamond-shaped illumination dưới mắt. Nguồn: PPA **2023-10**; Profoto, *How to Create Rembrandt Lighting*, **2020-05-14**; Nikon Glossary **n.d.**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
  - https://www.profoto.com/us/en/still-photography/tips-tricks/how-to-create-rembrandt-light/ImportedBlogPage
  - https://www.nikonusa.com/learn-and-explore/photography-glossary/g/1/focal-length-multiplier.html
- `[verified · confidence: high]` Split: PPA mô tả nguồn tại 3/9 giờ làm một nửa đầu sáng; Westcott mô tả nguồn 90° tạo hai nửa sáng/tối và dùng cho mood mạnh/kịch. Profoto đưa ví dụ portrait nhân vật dùng split vì concept cần drama. Nguồn: PPA **2023-10**; Westcott **n.d.**; Profoto/John Russo **n.d.**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
  - https://westcottu.com/4-essential-portrait-lighting-patterns
  - https://www.profoto.com/us/en/still-photography/profoto-stories/character-portraits-with-john-russo-and-profoto-d2/ImportedBlogPage
- `[verified · confidence: high]` Butterfly: PPA và Westcott cùng đặt nguồn cao, chính diện và nhận diện bằng bóng dưới mũi; cả hai cảnh báo nguồn quá cao làm mắt tối hoặc bóng kéo dài. PPA mô tả clamshell là butterfly cộng reflector/fill phía dưới, giúp làm mềm bóng. Nguồn: PPA **2023-10**; Westcott **n.d.**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
  - https://westcottu.com/4-essential-portrait-lighting-patterns
- `[verified · confidence: high]` Back/rim: PPA đặt nguồn phía sau chủ thể để tạo rim; Nikon định nghĩa rim là viền cơ thể được chiếu sáng bởi nguồn đặt sau. PPA năm 2026 cũng phân biệt vai trò key, fill và backlight: fill làm mềm bóng, backlight tạo separation. Nguồn: PPA **2023-10**; Nikon Glossary **n.d.**; PPA PhotoVision, *Studio Lighting Techniques for Portrait Photography*, **2026-04-27**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
  - https://www.nikonusa.com/learn-and-explore/photography-glossary/g/1/focal-length-multiplier.html
  - https://www.ppa.com/photovision/watch/studio-lighting-techniques-for-portrait-photography

#### 1.3. Chọn pattern theo brief, không theo giới tính hay preset

- `[supported · confidence: medium-high]` PPA khuyên ghép pose/mood với ánh sáng: pose tươi, chính diện thường hợp loop/butterfly; pose tối/kịch hợp Rembrandt/split. Đây là heuristic nghề nghiệp, không phải định luật phổ quát. Nguồn: Jeff Kent/PPA, *Corrective Posing and Lighting for Award-Winning Portraits*, **n.d.**; John Gress/PPA **2023-10**; truy cập **2026-07-29**.
  - https://www.ppa.com/ppmag/articles/corrective-posing-and-lighting-for-award-winning-portraits
  - https://www.ppa.com/ppmag/articles/9-types-of-portrait-lighting
- `[inference · confidence: high · 2026-07-29]` Cây quyết định cho agent:
  1. Brief cần **mở, gần gũi, dễ đọc mặt** → loop mềm; butterfly/clamshell nếu chính diện và polished.
  2. Brief cần **nội tâm, có trọng lượng** → Rembrandt với shadow còn texture; tăng contrast chỉ khi câu chuyện đòi hỏi.
  3. Brief cần **xung đột/đối cực rõ** → split; kiểm tra mắt phía tối và texture da.
  4. Brief cần **tách chủ thể hoặc glow ngược sáng** → rim/backlight; quyết định rõ mặt sẽ là silhouette, được fill tự nhiên, hay được dodge cục bộ.
- `[inference · confidence: high · 2026-07-29]` Khi chấm một ảnh có sẵn, VLM không được yêu cầu “đổi sang Rembrandt” bằng post-processing nếu hình học nguồn sáng gốc không hỗ trợ. Photo editor tham số chỉ có thể cân exposure, tone và dodge/burn cục bộ; nó không được giả lập lại hướng sáng hay vẽ một tam giác sáng giả.

### 2. Chữ ký nghệ sĩ, cinematographer và colorist

#### 2.1. Annie Leibovitz — chân dung như một cảnh kể về con người

- `[verified · confidence: high]` Một chiến lược nổi bật của Leibovitz là **environmental/editorial portrait**: địa điểm, đạo cụ, trang phục, cử chỉ và ánh sáng cùng cung cấp tiểu sử hoặc vai trò xã hội của người được chụp. Smithsonian đối chiếu các chân dung commissioned được dàn dựng, chiếu sáng kỹ với dự án *Pilgrimage*, nơi phòng, đồ vật và cảnh quan tự chúng vận hành như chân dung; TIME mô tả dự án *Face Forward* là chân dung đi cùng một phần đời sống của nhân vật. Claim này không có nghĩa mọi ảnh Leibovitz đều là environmental portrait. Nguồn: Smithsonian American Art Museum, *Annie Leibovitz: Pilgrimage*, **2012**; TIME, *Annie Leibovitz on the Google Pixel 4*, **2019-10-22**; truy cập **2026-07-29**.
  - https://americanart.si.edu/exhibitions/leibovitz
  - https://time.com/5706141/annie-leibovitz-google-pixel-4/
- `[supported · confidence: high]` Oeuvre của bà liên tục đặt ảnh người nổi tiếng được giao chụp cạnh ảnh gia đình, chiến tranh và mất mát; vì thế “chữ ký” đáng học là **đưa quan hệ/câu chuyện vào khung hình**, không phải một LUT tối hay một kiểu đèn duy nhất. Nguồn: Brooklyn Museum, *Annie Leibovitz: A Photographer’s Life, 1990–2005*, **2006**; Smithsonian **2012**; truy cập **2026-07-29**.
  - https://www.brooklynmuseum.org/exhibitions/annie_leibovitz
  - https://americanart.si.edu/exhibitions/leibovitz
- `[inference · confidence: high · 2026-07-29]` **VLM nên hỏi:** môi trường tiết lộ điều gì về nhân vật; đạo cụ có làm nhiệm vụ kể chuyện hay chỉ trang trí; gesture, eye line và khoảng cách máy ảnh tạo quyền lực/thân mật ra sao; vùng sáng nhất có dẫn tới mặt hoặc vật mang nghĩa không?
- `[inference · confidence: high · 2026-07-29]` **Không được học sai:** “Leibovitz = vignette nặng + da desaturated + nền tối”. Hãy học sự thống nhất giữa nhân vật và bối cảnh; grade phải phục vụ cấu trúc kể chuyện sẵn có, không dựng thêm tiểu sử giả.

#### 2.2. Steve McCurry — màu có cấu trúc, ánh nhìn có sức nặng

- `[verified · confidence: high]` McCurry dùng màu mạnh nhưng đặt **human element** ở trung tâm: trang chính thức nhấn vào xung đột, văn hóa biến mất, truyền thống và con người; ICP mô tả khả năng dùng màu cùng sự kết nối với chủ thể. Nguồn: Steve McCurry, *About*, **n.d.**; ICP, *Steve McCurry: India*, **2015-11-18**; truy cập **2026-07-29**.
  - https://www.stevemccurry.com/about
  - https://www.icp.org/exhibitions/steve-mccurry-india
- `[verified · confidence: high]` Ánh mắt trực diện là một mô-típ có sức mạnh, đặc biệt trong *Afghan Girl*, nhưng phát biểu của McCurry rộng hơn: ông tìm khoảnh khắc không phòng bị, nơi trải nghiệm in trên gương mặt. George Eastman Museum ghi ông chỉ dùng Kodachrome trong nhiều thập niên và coi trọng bảng màu sống động nhưng trung thực, không garish/cartoonish. Nguồn: Steve McCurry, *Portraits*, **n.d.**; ICP **2015-11-18**; George Eastman Museum, *Eastman House painted with color—this week with Kodachrome*, **2011-06-14**; truy cập **2026-07-29**.
  - https://www.stevemccurry.com/portraits
  - https://www.icp.org/exhibitions/steve-mccurry-india
  - https://www.eastman.org/blog/eastman-house-painted-color-week-kodachrome
- `[inference · confidence: high · 2026-07-29]` **VLM nên hỏi:** màu chủ đạo–màu nhấn có khóa mắt vào gương mặt không; màu áo/tường/bối cảnh tạo quan hệ bổ túc hay lặp nhịp nào; gaze có thật sự là tâm điểm hay bị vùng bão hòa khác tranh chấp; môi trường thêm văn hóa/câu chuyện gì?
- `[verified · confidence: high]` Tranh luận năm 2016 về việc clone/xóa yếu tố trong ảnh McCurry là một cảnh báo đạo đức trực tiếp: ảnh documentary không được “làm sạch” bằng cách xóa người/vật rồi vẫn trình bày như khoảnh khắc quan sát được. Nguồn: TIME, *Fact, Truth and Photography in the Digital Age*, **2016-05-12**; truy cập **2026-07-29**.
  - https://time.com/4326791/fact-truth-photography-steve-mccurry/
- `[inference · confidence: high · 2026-07-29]` **Không được học sai:** “McCurry = kéo saturation đỏ/cam/xanh lên hết cỡ” hoặc “mọi chân dung phải có mắt xanh”. Chữ ký chuyển thành bài học về quan hệ màu, sự hiện diện con người và giới hạn chỉnh sửa documentary — không phải LUT.

#### 2.3. Henri Cartier-Bresson — decisive moment là sự hội tụ của nghĩa và hình

- `[verified · confidence: high]` “Khoảnh khắc quyết định” không chỉ là bắt đúng đỉnh chuyển động. MoMA giải thích nó là sự tương tác giữa **ý nghĩa con người của sự kiện** và **tổ chức hình thức**; ICP mô tả ảnh của Cartier-Bresson vừa nắm bắt sự việc tự phát vừa tổ chức thị giác chính xác. Nguồn: MoMA, *Seville, Spain (1933)*, **n.d.**; ICP, hồ sơ Henri Cartier-Bresson, **n.d.**; truy cập **2026-07-29**.
  - https://www.moma.org/collection/works/49890
  - https://www.icp.org/browse/archive/constituents/henri-cartier-bresson?page=1
- `[verified · confidence: high]` Cụm từ nổi tiếng còn là kết quả của tiêu đề bản tiếng Anh năm 1952 cho *Images à la Sauvette*, nên không nên biến nó thành khẩu hiệu giải thích toàn bộ sự nghiệp. ICP và Fondation HCB cùng ghi lịch sử tiêu đề; catalogue MoMA cảnh báo cách đọc này có thể giản lược một oeuvre phong phú. Nguồn: ICP, *Henri Cartier-Bresson: The Decisive Moment*, **2018**; Fondation Henri Cartier-Bresson, ấn bản *The Decisive Moment*, **n.d.**; MoMA, *The Early Work*, **1987**; truy cập **2026-07-29**.
  - https://www.icp.org/exhibitions/henri-cartier-bresson-decisive-moment
  - https://www.henricartierbresson.org/en/publications/henri-cartier-bresson-the-decisive-moment-new-edition/
  - https://www.moma.org/documents/moma_catalogue_2165_300296079.pdf
- `[supported · confidence: high]` Catalogue MoMA ghi bố cục cuối cùng được quyết định ở lúc bấm máy và bản âm được dùng trọn, gắn với quan tâm của ông về tổ chức không gian/hình thức. Đây là nguyên tắc làm việc lịch sử của Cartier-Bresson, không phải luật cấm crop cho mọi nhiếp ảnh gia. Nguồn: MoMA, *Henri Cartier-Bresson: Photographer*, **1979**; truy cập **2026-07-29**.
  - https://www.moma.org/documents/moma_catalogue_464_300062051.pdf
- `[inference · confidence: high · 2026-07-29]` **VLM nên hỏi:** gesture và quan hệ giữa các người/vật có đạt điểm không thể thay thế chưa; hình học, khoảng trống và nhịp có cùng “khép” đúng lúc không; nếu lùi/tiến một nhịp thì nghĩa hay hình thức mất gì? Một đường chéo đẹp nhưng sự kiện rỗng chưa phải decisive moment.

#### 2.4. Fan Ho — ánh sáng là kiến trúc, con người là nhịp và tỷ lệ

- `[verified · confidence: high]` Estate của Fan Ho mô tả ông kiên nhẫn chờ nhân vật đi vào nền hình học đã được cấu trúc; các mô-típ gồm backlight, khói gặp tia sáng, bóng chéo dài, đường phố và chợ. M+ nhấn vào đời sống Hong Kong thập niên 1950–60 và tư duy kể chuyện được nuôi bởi điện ảnh. Nguồn: Fan Ho Estate, *About Fan Ho*, **n.d.**; M+, *10 Facts about Fan Ho*, **2018-09-27**; truy cập **2026-07-29**.
  - https://fanho-forgetmenot.com/about
  - https://www.mplus.org.hk/en/magazine/10-facts-about-the-photographer-who-documented-1950s-and-60s-hong-kong/
- `[verified · confidence: high]` Ảnh đen trắng của ông không chỉ “contrast cao”: M+ diễn giải nó tạo khoảng cách và không gian suy tưởng, còn các vùng sáng/bóng tổ chức cảnh thành cấu trúc gần trừu tượng nhưng vẫn neo ở đời sống người. Nguồn: M+ **2018-09-27**; M+, *Noir & Blanc—A Story of Photography*, **2024**; truy cập **2026-07-29**.
  - https://www.mplus.org.hk/en/magazine/10-facts-about-the-photographer-who-documented-1950s-and-60s-hong-kong/
  - https://www.mplus.org.hk/en/exhibitions/noir-blanc-a-story-of-photography/
- `[supported · confidence: high]` Không phải mọi cảnh mang vẻ street-candid đều hoàn toàn tự phát: Sotheby’s ghi một số ảnh, gồm *Back Alley*, có yếu tố khói hoặc nhân vật được dàn dựng. Nguồn: Sotheby’s, *Hong Kong Through the Lens of Fan Ho*, **n.d.**; truy cập **2026-07-29**.
  - https://www.sothebys.com/en/slideshows/hong-kong-through-the-lens-of-fan-ho
- `[inference · confidence: high · 2026-07-29]` **VLM nên hỏi:** tia sáng dẫn đến đâu; người có làm điểm đo tỷ lệ và chặn đúng giao điểm hình học không; shadow tạo layer hay chỉ bít chi tiết; haze có phân tách mặt phẳng không? **Không được học sai:** “Fan Ho = crush black + Dehaze + thêm light ray”. Tia sáng phải tồn tại trong ảnh; editor chỉ được đặt tone, không sinh tia hay người.

#### 2.5. Rinko Kawauchi — ánh sáng sữa, đời thường mong manh, chuỗi ảnh tạo nghĩa

- `[verified · confidence: high]` Kawauchi chú ý những bí ẩn nhỏ của đời thường và trạng thái lửng giữa mơ–thức; nguồn triển lãm chính thức mô tả màu dịu thấm ánh sáng, sự rạng rỡ/mong manh/sức sống. Nguồn: SFMOMA, video về Rinko Kawauchi, **n.d.**; triển lãm chính thức *Rinko Kawauchi: M/E*, **2023**; truy cập **2026-07-29**.
  - https://www.sfmoma.org/watch/%E5%B7%9D%E5%86%85%E5%80%AB%E5%AD%90%E3%81%8C%E4%B8%96%E3%81%AE%E4%B8%AD%E3%81%AE%E5%B0%8F%E3%81%95%E3%81%AA%E8%AC%8E%E3%82%92%E8%80%83%E5%AF%9F%E3%81%99%E3%82%8B/
  - https://rinkokawauchi-me.exhibit.jp/en/
- `[verified · confidence: high]` “Airy pastel” chỉ là lớp bề mặt. Phỏng vấn trên website của Kawauchi nói tới màu tự nhiên/milky, ánh sáng và cái thường ngày bị bỏ qua, nhưng cũng tới bóng tối, hỗn loạn, lời cầu nguyện và cách **sequencing** nối mô-típ. TIME cũng nhấn vào juxtaposition/sequence khiến điều tầm thường thành lạ. Nguồn: *Unseen Magazine 4*, PDF lưu trên website Rinko Kawauchi, **2017**; TIME, *Rinko Kawauchi’s Illuminance*, **2011-05-23**; truy cập **2026-07-29**.
  - https://rinkokawauchi.com/en/wp-content/uploads/sites/2/2017/12/2017_Unseen-Magazine-4.pdf
  - https://time.com/3776240/rinko-kawauchis-illuminance/
- `[supported · confidence: medium-high]` Nippon.com mô tả màu pastel/tinh tế, bố cục vuông 6×6 và đối cực sáng–tối, sống–chết, đồng thời cảnh báo không nên giản lược tác phẩm thành một “Japanese style” đồng nhất. Nguồn: Nippon.com, *Kawauchi Rinko: Finding Eternity in the Everyday*, **2021-02-09**; truy cập **2026-07-29**.
  - https://www.nippon.com/en/images/i00053/kawauchi-rinko-finding-eternity-in-the-everyday.html
- `[inference · confidence: high · 2026-07-29]` **VLM nên hỏi:** ánh sáng có biến chi tiết nhỏ thành điểm chú ý không; highlight còn chuyển sắc hay đã trắng bệt; màu nhẹ có giữ memory color; cặp hình/mô-típ tạo liên tưởng gì? **Không được học sai:** nâng black, giảm clarity và làm mờ mọi ảnh. Sự mong manh cần chi tiết, khoảng thở và đối cực, không phải thiếu điểm đen toàn cục.

#### 2.6. “Deakins-style naturalism” và nghề colorist — tự nhiên là kết quả thiết kế có động cơ

- `[verified · confidence: high]` **Roger Deakins là cinematographer/DP, không phải colorist.** ASC cho thấy ông tích hợp ánh sáng với kiến trúc, practical và màu trường quay; ở *Fargo*, cảm giác tự nhiên được xây từ nguồn sáng có vẻ hợp lý trong bối cảnh, kể cả khi practical/gag light được tăng cường. Nguồn: American Society of Cinematographers, *Blade Runner 2049*, **2018-01-08**; ASC, *Fargo: Cold-Blooded Scheming*, **n.d.**; truy cập **2026-07-29**.
  - https://theasc.com/articles/deakins-blade-runner-2049
  - https://theasc.com/articles/fargo-cold-blooded-scheming
- `[supported · confidence: high]` Deakins nói ưu tiên “quality of light” và làm rất ít ở DI; ông cũng cảnh báo tạo một hiệu ứng ánh sáng không có trên set trong post thường khó đạt độ thật. Đây là phát biểu nghề nghiệp trên diễn đàn chính thức, không phải công thức áp cho mọi đoàn phim. Nguồn: Roger Deakins forum, *Lighting*, **2023-03-26**; *Split tone look / in camera*, **2023-02-05**; truy cập **2026-07-29**.
  - https://www.rogerdeakins.com/forums/topic/lighting/
  - https://www.rogerdeakins.com/forums/topic/split-tone-look-how-much-to-get-in-camera/
- `[verified · confidence: high]` Mitch Paulson là colorist cộng tác lâu dài: Frame.io ghi ông grade mọi phim của Deakins từ *True Grit*, hai người ngồi cùng suốt grade, chốt look sớm và dùng điều chỉnh tinh tế; ASC cũng gọi Paulson là longtime colorist. Nguồn: Frame.io, phỏng vấn Mitch Paulson, **2019-03-04**; ASC, *Lives Under Siege: The Goldfinch and 1917*, **2019-09-26**; truy cập **2026-07-29**.
  - https://blog.frame.io/2019/03/04/mitch-paulson-efilm/
  - https://theasc.com/articles/lives-under-siege-the-goldfinch-and-1917
- `[verified · confidence: high]` Colorist hàng đầu không nhất thiết có một palette lặp lại. Jill Bogdanowicz mô tả mục tiêu là không áp look từ ngoài mà phục vụ cảm xúc; các case *Wicked* và *Joker: Folie à Deux* cho thấy cân màu đối nghịch, bảo vệ sắc da/màu ký ức, LUT được thiết kế trước và mức cyan/saturation được tiết chế theo câu chuyện. Nguồn: Company 3, *Sundance Favorites*, **2017-01-20**; *Wicked: Pink & Green*, **2024-11-13**; *Joker: Folie à Deux*, **2024-10-21**; truy cập **2026-07-29**.
  - https://www.company3.com/company-3-colors-sundance-favorites-celebrates-indie-filmmaking/
  - https://www.company3.com/wicked-pink-green/
  - https://www.company3.com/bogdanowicz-colors-joker2/
- `[inference · confidence: high · 2026-07-29]` **VLM nên hỏi:** nguồn sáng có động cơ từ không gian không; practical/cửa sổ/bầu trời có giải thích hướng, màu và falloff; palette có thống nhất nhưng từng vật vẫn phân biệt; da và neutral có còn đáng tin; grade có được cảm thấy như “thế giới này vốn vậy” không?
- `[inference · confidence: high · 2026-07-29]` **Không được học sai:** “Deakins = ánh sáng có sẵn” hoặc một LUT teal–orange. Naturalism ở đây là **believability có thiết kế**, còn colorist bảo toàn ý đồ, continuity và separation — không đóng dấu cá nhân lên mọi phim.

### 3. Các cụm thẩm mỹ châu Á đang lưu hành năm 2025–26

#### 3.1. Giới hạn của chữ “thịnh hành”

- `[open · confidence: high · 2026-07-29]` Không tìm thấy một khảo sát đại diện toàn thị trường Nhật–Hàn–Việt–Trung trong 2025–26 đo tỷ lệ sử dụng các look dưới đây. Bằng chứng hiện có gồm trang sản phẩm chính hãng, bài kỹ thuật, studio thương mại và tín hiệu tutorial/video công khai. Vì vậy tài liệu gọi đây là **cụm thẩm mỹ/vernacular đang lưu hành**, không xếp hạng thị phần.
- `[supported · confidence: medium-high]` Bối cảnh rộng năm 2026 có phản ứng chống vẻ quá hoàn hảo: blur, grain, motion và dấu vết analog được dùng để đưa tính người trở lại ảnh số. Đây là xu hướng báo chí ngành ghi nhận, không riêng châu Á. Nguồn: Digital Camera World, *Are film photography apps… the 2026 antidote to AI imagery?*, **2026-03-29**; truy cập **2026-07-29**.
  - https://www.digitalcameraworld.com/tech/apps/are-film-photography-apps-that-add-blur-and-grain-to-perfect-photos-the-2026-antidote-to-ai-imagery

#### 3.2. Japanese airy / 日系空气感 — sáng, nhẹ, có khoảng thở

- `[supported · confidence: medium-high]` Tín hiệu creator Trung Quốc cho thấy tên gọi “日系空气感/清透/柔雾” vẫn hoạt động trong 2025–26. Một tutorial Fujifilm ngày **2025-09-26** công bố recipe exposure +1/3 đến +1 EV, highlight/shadow hạ và DR400; một tutorial “日系柔雾感” ngày **2026-07-03** đạt khoảng **15,4 nghìn lượt xem** tại snapshot **2026-07-29**. Đây là bằng chứng về từ vựng/look đang lưu hành trên Bilibili, không phải thống kê toàn châu Á. Nguồn: Bilibili BV1Hun3zBEQq, **2025-09-26**; BV1mAT466Eu3, **2026-07-03**; API công khai truy cập **2026-07-29**.
  - https://www.bilibili.com/video/BV1Hun3zBEQq
  - https://www.bilibili.com/video/BV1mAT466Eu3
- `[supported · confidence: medium]` Mỹ học “airy/translucent/pastel” còn xuất hiện trong định hướng beauty Nhật mùa xuân–hè 2026 của Shiseido Professional. Đây là bằng chứng liên ngành về bảng màu và cảm giác, không phải bằng chứng trực tiếp cho kỹ thuật nhiếp ảnh. Nguồn: Shiseido Professional, *2026 Spring/Summer Beauty Trends*, **2026**; truy cập **2026-07-29**.
  - https://www.shiseido-professional.com/com/en/trending/trends/beauty-creators-inspire/2026-spring-summer.html
- `[inference · confidence: medium-high · 2026-07-29]` **Ngữ pháp nhìn:** mids sáng; contrast thấp–vừa; highlight có glow nhưng còn chuyển sắc; black có thể hơi nâng chứ không mất neo; saturation tiết chế; ambient sạch/hơi mát nhưng da ấm-trung tính; negative space và daylight mềm tạo “không khí”.
- `[inference · confidence: high · 2026-07-29]` **Lỗi thường gặp:** kéo exposure tới cháy váy/da, dùng negative clarity toàn cục, nâng black làm ảnh không còn điểm tựa, hoặc nhuộm cyan cả da. Airy là placement của tone và khoảng thở, không phải ảnh thiếu contrast có chủ ý mơ hồ.

#### 3.3. Korean film tone — da sạch, roll-off mềm, nostalgia có kiểm soát

- `[supported · confidence: medium]` “Korean film tone” không phải một profile chuẩn hóa. Trong cùng hệ sinh thái Fujifilm Korea, ASTIA được mô tả có màu/gradation mềm và skin tone đẹp; PRO Neg.Std ưu tiên gradation/skin mềm; Nostalgic Neg. dùng highlight amber và giữ màu trong shadow. Sự đa dạng này cho thấy nhãn “film tone” bao phủ nhiều palette, không chỉ một công thức beige. Nguồn: Fujifilm Korea, trang X-M5, **2024-10-14**; trang X-E5, **2025-06-12**; truy cập **2026-07-29**.
  - https://fujifilm-korea.co.kr/products/id/1337
  - https://fujifilm-korea.co.kr/products/id/1350
- `[supported · confidence: medium-low]` Nội dung studio thương mại K-drama-style năm 2025 dùng ánh sáng mềm, cảm giác romantic và tương tác tự nhiên. Nguồn marketing này hữu ích để đọc vernacular, nhưng không độc lập về thị phần và không đủ để chuẩn hóa “Korean style”. Nguồn: Modu Studios, *K-drama Style Photos in Seoul*, **2025-08-25**; truy cập **2026-07-29**.
  - https://www.modustudios.com/blog/how-to-get-kdrama-style-photos-in-seoul
- `[supported · confidence: medium-low]` Ở Việt Nam, báo chí/chuỗi studio ghi nhận photobooth mang theme Hàn và tệp khách trẻ trong 2025, nhưng bài mang tính giới thiệu thương hiệu nên chỉ dùng như tín hiệu thương mại. Nguồn: VnExpress, *Fun Studio tiên phong xu hướng chụp ảnh photobooth*, **2025-04-01**; truy cập **2026-07-29**.
  - https://vnexpress.net/fun-studio-tien-phong-xu-huong-chup-anh-photobooth-4857200.html
- `[inference · confidence: medium-high · 2026-07-29]` **Ngữ pháp nhìn:** bố cục gọn; skin hue tự nhiên và sáng hơn nền vừa đủ; contrast vừa hoặc thấp; shoulder highlight êm; green/blue thường bớt gắt; mid có thể neutral, ấm hoặc hơi peach; grain nhỏ là tùy chọn, không phải bằng chứng “film”.
- `[inference · confidence: high · 2026-07-29]` **Lỗi thường gặp:** làm da trắng xám, đẩy shadow xanh vô cớ, thêm grain lớn đồng đều, hoặc coi “Korean” là một preset dân tộc cố định. Agent phải mô tả tone cụ thể của ảnh tham chiếu thay vì suy từ nhãn.

#### 3.4. Chân dung “thơ mộng” Việt/Trung — ngược sáng, bong bóng và chuyển động lớp trước

- `[supported · confidence: medium-high]` Tutorial/ảnh mẫu Trung Quốc năm 2025–26 lặp lại một cụm kỹ thuật: ánh sáng cuối ngày hoặc ngược/xiên ngược, tóc/vai có viền sáng, bọt xà phòng đi qua vùng nắng thành bokeh/specular foreground, khẩu lớn và fill mặt. Video Bilibili *如何把泡泡人像拍出梦幻感？* ngày **2025-07-03** đạt khoảng **21 nghìn lượt xem** ở snapshot **2026-07-29**; video “通透发光” ngày **2026-07-27** mô tả chụp lúc 17 giờ bằng ánh sáng xiên ngược. Nguồn: Bilibili BV1hu3TzSEsu, **2025-07-03**; BV1hXgY6GE23, **2026-07-27**; API công khai truy cập **2026-07-29**.
  - https://www.bilibili.com/video/BV1hu3TzSEsu
  - https://www.bilibili.com/video/BV1hXgY6GE23
- `[supported · confidence: medium]` Hướng dẫn mùa tốt nghiệp 2025 của 享像派 đề xuất máy bong bóng, ánh sáng mềm cuối ngày/cửa sổ ngược sáng và HDR; các bài ý tưởng tốt nghiệp Trung Quốc cùng năm dùng chạy, tung mũ, thổi bong bóng và silhouette ngược sáng. Đây là nguồn thương mại/editorial, không phải nghiên cứu thị trường. Nguồn: 享像派, *2025毕业季跟拍全攻略*, **2025**; Sohu, bài ý tưởng ảnh tốt nghiệp, **2025**; truy cập **2026-07-29**.
  - https://www.xxpie.com/tips/226.html
  - https://www.sohu.com/a/896472033_649165
  - https://www.sohu.com/a/906239859_120977781
- `[verified · confidence: high]` Về cơ chế ánh sáng, Canon hướng dẫn rằng backlight dễ làm mặt tối; reflector/fill flash cân mặt trong khi giữ hair rim, và khẩu lớn biến tiền cảnh sáng thành bokeh mềm. Đây là nền kỹ thuật chắc hơn các mô tả trend. Nguồn: Canon China, hướng dẫn backlight/flash portrait, **n.d.**; Canon EOS portrait và DSLR ABC, **n.d.**; truy cập **2026-07-29**.
  - https://www.canon.com.cn/special/speedlite/flash-tips30.html
  - https://www.canon.com.cn/special/canon_portrait/1.html
  - https://www.canon.com.cn/special/ds_abcbook/tips02.html
- `[open · confidence: high · 2026-07-29]` Chưa có dữ liệu độc lập đủ mạnh để kết luận bong bóng ngược sáng là phong cách “thống trị” ảnh tốt nghiệp Việt Nam năm 2025–26. Có studio Việt tiếp thị concept Hàn/party-night/kỷ yếu trong 2025, nhưng đó là bằng chứng về cung dịch vụ, không phải tỷ lệ khách chọn. Nguồn: Lens Xoắn, danh sách studio kỷ yếu, **2025**; Cộng Studio, *Kỷ yếu Party Night*, **2025**; truy cập **2026-07-29**.
  - https://lensxoan.vn/blogs/kham-pha/top-10-studio-chup-anh-ky-yeu-dep-uy-tin-ha-noi
  - https://congstudio.vn/chup-anh-ky-yeu-party-night-hot-nhat-tai-cong-studio/
- `[inference · confidence: high · 2026-07-29]` **Ngữ pháp nhìn:** exposure ưu tiên mặt; backlight được phép bloom khoảng 1/2–1 stop nhưng vùng váy/da quan trọng không clip; bubble tạo ba lớp tiền–trung–hậu cảnh và nhịp chuyển động; reflector/fill tự nhiên giữ mắt; saturation giảm nhẹ; highlight ấm, shadow sạch/hơi mát; crop giữ hướng bay/chuyển động.
- `[inference · confidence: high · 2026-07-29]` **Lỗi thường gặp:** dodge bong bóng giả, sinh thêm bubble/bokeh, blur da như beauty filter, hoặc phục hồi “chi tiết” từ vùng đã clip bằng resynthesis. Photo editor chỉ được giữ/đặt tone của ánh sáng và bọt đã có trong ảnh.

### 4. Ngôn ngữ phê bình để VLM tự chấm ảnh

#### 4.1. Từ “có gì” sang “nó làm gì”

- `[supported · confidence: high]` Formal analysis xem scale, composition, pictorial space, form, line, color, light, tone, texture và pattern như các quan hệ tạo ấn tượng chung; chiều sâu có thể được gợi bằng overlap. Đây là mô hình **close looking**, không phải checklist quy tắc đẹp. Nguồn: Smarthistory, *How to do visual (formal) analysis*, **n.d.**; *Understanding art: an introduction*, **n.d.**; truy cập **2026-07-29**.
  - https://smarthistory.org/visual-analysis/
  - https://smarthistory.org/introduction-to-art-historical-analysis/
- `[supported · confidence: high]` Nghiên cứu composition-aware cho thấy bố cục nên được mô hình như **quan hệ phụ thuộc giữa các vùng cục bộ**, không chỉ ánh xạ toàn ảnh sang điểm cao/thấp. Nguồn: Liu et al., *Composition-Aware Image Aesthetics Assessment*, WACV, **2020-03**; truy cập **2026-07-29**.
  - https://openaccess.thecvf.com/content_WACV_2020/html/Liu_Composition-Aware_Image_Aesthetics_Assessment_WACV_2020_paper.html
- `[inference · confidence: high · 2026-07-29]` Câu phê bình tối thiểu phải có dạng: **Quan sát → Quan hệ → Tác động → Liên hệ ý đồ → Hành động có giới hạn → Độ tin cậy**. Ví dụ: “Đường lan can bắt đầu ở góc trái dưới, đi qua bàn tay rồi kết thúc sau đầu; nó dẫn mắt tới nhân vật nhưng tangent ở cổ làm silhouette rối. Nếu brief ưu tiên gương mặt, crop 3–5% bên trái hoặc burn rail khoảng 0,2 EV; confidence 0,82.”

#### 4.2. Từ điển bố cục/tone có thể kiểm chứng

| Khái niệm | Câu hỏi buộc VLM trả lời | Ngôn ngữ tốt | Ngôn ngữ rỗng cần cấm |
|---|---|---|---|
| **Leading lines** | Đường bắt đầu ở đâu, đi theo path nào, kết thúc ở đâu? Nó dẫn tới chủ thể, chạy vòng trong khung hay đẩy mắt ra mép? | “Hai mép cầu hội tụ sau vai và trả mắt về mặt; đường sáng thứ ba thoát ra góc phải, cạnh tranh nhẹ.” | “Có leading lines đẹp”, “đường chéo năng động”. |
| **Layering / depth** | Có tiền–trung–hậu cảnh không? Depth đến từ overlap, scale, focus, haze, luminance hay color temperature? Có tangent/merger làm phẳng lớp? | “Bong bóng mờ ở tiền cảnh, nhân vật nét ở trung cảnh, cây lạnh/mềm phía sau tạo ba lớp; bubble che mắt làm hỏng hierarchy.” | “Ảnh có chiều sâu”, “bokeh cinematic”. |
| **Figure-to-ground** | Silhouette chủ thể tách khỏi nền bằng value, hue/chroma, focus, texture, edge light hay negative space? Vùng nào bị merger? | “Tóc tối nhập vào cửa tối; rim chỉ cứu nửa trái. Dodge tóc 0,2 EV hoặc burn cửa cục bộ, không tăng contrast toàn ảnh.” | “Chủ thể chưa nổi, tăng contrast/pop.” |
| **Balance / visual weight** | Vùng sáng, bão hòa, nét, mặt/người và vật lớn phân bố ra sao? Khoảng trống là chủ ý hay dead space? | “Mặt trái khung được đối trọng bởi cửa sổ nhỏ sáng bên phải; crop cửa sẽ làm khung lệch.” | “Theo rule of thirds nên đẹp.” |
| **Color harmony** | Màu chủ đạo, màu phụ và accent là gì? Quan hệ analogous/complementary/monochrome mô tả hue nào; value/chroma của chúng có cạnh tranh không? Skin/memory color còn tin được không? | “Nền cyan muted bổ túc áo đỏ nhưng bảng hiệu đỏ sáng hơn mặt; giảm saturation/luminance bảng hiệu cục bộ.” | “Teal–orange luôn cinematic”, “màu bổ túc tự động hài hòa.” |
| **Tone placement** | Black point nằm đâu; mặt/da ở vùng sáng nào; highlight còn headroom; contrast pivot ở đâu; shadow có texture; vùng sáng nhất phục vụ ai? | “Da ở upper-mid, váy giữ texture, cửa sổ clip nhỏ không mang thông tin; black mềm hợp mood airy.” | “Histogram chưa kéo hết”, “ảnh thiếu punch.” |
| **Moment / gesture** | Hướng mắt, tay, thân và quan hệ người–vật đang tạo nghĩa gì? Một nhịp trước/sau có mạnh hơn không? | “Hai bàn tay vừa chạm trong khi ánh mắt lệch nhau; căng thẳng nằm ở bất đồng gesture–gaze.” | “Bắt khoảnh khắc quyết định” mà không nêu sự kiện và hình thức. |

**Bằng chứng cho từ điển:**

- `[supported · confidence: high]` Nikon định nghĩa leading lines là yếu tố tuyến tính đưa mắt đi xuyên ảnh hoặc tới vùng focal; cũng thừa nhận chúng có thể dẫn mắt ra ngoài. Vì vậy sự tồn tại của đường không tự động là thành công. Nguồn: Nikon USA, *5 Easy Composition Guidelines*, **n.d.**; *Where to Draw the Line*, **n.d.**; truy cập **2026-07-29**.
  - https://www.nikonusa.com/learn-and-explore/c/tips-and-techniques/5-easy-composition-guidelines
  - https://www.nikonusa.com/learn-and-explore/c/nikon-creators/where-to-draw-the-line
- `[verified · confidence: high]` Nikon minh họa figure–ground bằng chủ thể sáng trên nền tối và negative space; Smarthistory cho thấy overlap tạo cảm giác vật trước–sau. Đây là nền cho phép chấm separation theo nhiều cue cục bộ thay vì chỉ global contrast. Nguồn: Nikon USA, *Composing Photographs*, **n.d.**; Smarthistory, *Visual Analysis*, **n.d.**; truy cập **2026-07-29**.
  - https://www.nikonusa.com/learn-and-explore/c/tips-and-techniques/composing-photographs
  - https://smarthistory.org/visual-analysis/
- `[supported · confidence: high]` Color wheel mô tả bốn quan hệ cơ bản complementary, analogous, triadic và monochromatic. Nguồn: Adobe Help Center, *Understanding color combinations*, **2024-06-17**; truy cập **2026-07-29**.
  - https://helpx.adobe.com/lt/illustrator/how-to/experiment-with-color-combinations-hybrid.html
- `[inference · confidence: high · 2026-07-29]` Tên color scheme chỉ mô tả quan hệ hue; chất lượng harmony còn phụ thuộc tỷ lệ diện tích, value, chroma, memory color và ý đồ. “Complementary” không tự động nghĩa là đẹp.

#### 4.3. Bằng chứng về cách VLM hiện nay thất bại

- `[supported · confidence: high]` PhotoCritique phân biệt nhận diện vật thể thông thường với hiểu thẩm mỹ về color, lighting và composition; dataset chứa khoảng 2,6 triệu mẫu instruction từ thảo luận của hơn 107.000 người yêu nghề/chuyên gia, trên hơn 70 thể loại. Nội dung critique còn nói tác động thẩm mỹ và cách cải thiện. Nguồn: Qi et al., *The Photographer’s Eye*, CVPR, **2025-06**; truy cập **2026-07-29**.
  - https://openaccess.thecvf.com/content/CVPR2025/html/Qi_The_Photographers_Eye_Teaching_Multimodal_Large_Language_Models_to_See_CVPR_2025_paper.html
- `[supported · confidence: high]` AesBench tách năng lực thành Perception, Empathy, Assessment và Interpretation trên 2.800 ảnh gán nhãn chuyên gia, và kết luận MLLM hiện tại còn khoảng cách đáng kể so với con người. Nguồn: Huang et al., *AesBench*, arXiv, **2024-01-16**; project page, **2024**; truy cập **2026-07-29**.
  - https://arxiv.org/abs/2401.08276
  - https://aesbench.github.io/
- `[supported · confidence: high]` Venus/AesGuide xác định lỗi cụ thể của MLLM: phản hồi quá tích cực, không chỉ ra vấn đề và không đưa hướng dẫn actionable; AesGuide gồm 10.748 ảnh có score, analysis và guidance. Nguồn: Du et al., *Venus*, arXiv, **2026-02-27**; bản CVPR **2026-06**; truy cập **2026-07-29**.
  - https://arxiv.org/abs/2602.23980
  - https://openaccess.thecvf.com/content/CVPR2026/papers/Du_Venus_Benchmarking_and_Empowering_Multimodal_Large_Language_Models_for_Aesthetic_CVPR_2026_paper.pdf
- `[supported · confidence: high]` RPCD cho thấy critique ngôn ngữ giàu thông tin hơn một scalar score: 74.000 ảnh và 220.000 bình luận từ cộng đồng critique Reddit. Tuy nhiên nguồn cộng đồng này mang prior văn hóa/ngôn ngữ của nền tảng, nên không thể xem là chân lý thẩm mỹ phổ quát. Nguồn: Jin et al., *Understanding Aesthetics with Language*, arXiv, **2022-06-17**; truy cập **2026-07-29**.
  - https://arxiv.org/abs/2206.08614
- `[inference · confidence: high · 2026-07-29]` Thiết kế agent phải chống ba lỗi: **khen xã giao**, **đếm rule**, **đề xuất không thi hành được**. Mỗi weakness phải được định vị, xếp mức ảnh hưởng và ánh xạ sang một edit tham số được phép; nếu không có edit an toàn thì nói “capture issue / không sửa bằng pipeline này”.

## Mô hình chấm đề xuất

### 5.1. Quy trình hai tầng: gate trước, score sau

1. `[inference · confidence: high · 2026-07-29]` **Gate tính hợp lệ:** kiểm tra sai nhận diện, uncertainty, clipping/blur không phục hồi được, ràng buộc documentary, identity/geometry và các thao tác bị cấm. Fail gate không có nghĩa ảnh xấu; nó có nghĩa agent không được hứa một chỉnh sửa vượt bằng chứng hoặc quyền hạn.
2. `[inference · confidence: high · 2026-07-29]` **Đọc ý đồ:** đoán genre, chủ thể, story và look trong một câu; ghi confidence. Nếu brief người dùng có sẵn thì brief thắng suy đoán của model.
3. `[inference · confidence: high · 2026-07-29]` **Chấm sáu trục 0–4:** mỗi điểm phải kèm một evidence span định vị được. Không cộng thành “độ đẹp tuyệt đối” nếu không có target/genre.
4. `[inference · confidence: high · 2026-07-29]` **Ưu tiên can thiệp:** chỉ nêu tối đa ba thay đổi theo impact × confidence ÷ risk; ghi phạm vi tham số và điều không được đổi.
5. `[inference · confidence: high · 2026-07-29]` **Look-again:** render preview, chấm lại đúng sáu trục và kiểm tra regression. Điểm cao hơn không được biện minh cho da sai hue, mất highlight hoặc thay đổi identity.

### 5.2. Sáu trục 0–4

| Trục | 0 | 2 | 4 |
|---|---|---|---|
| **Ý đồ & khoảnh khắc** | Không xác định được chủ thể/gesture mâu thuẫn vô nghĩa | Ý đồ đọc được nhưng generic hoặc moment chưa khép | Story, gesture và timing cùng rõ; chi tiết phụ củng cố nghĩa |
| **Ánh sáng & exposure** | Mặt/chi tiết chủ đạo mất vì clip/block hoặc hướng sáng khó đọc | Exposure dùng được, hierarchy sáng chưa dứt khoát | Pattern, quality, ratio và headroom phục vụ đúng mood |
| **Hierarchy & figure–ground** | Chủ thể nhập nền hoặc bị distractor mạnh lấn | Tách được nhưng có merger/tangent cục bộ | Subject đọc ngay; local contrast/edge/space điều hướng có chủ ý |
| **Không gian & bố cục** | Đường/lớp/crop đẩy mắt khỏi nội dung | Cấu trúc ổn nhưng có dead zone hoặc layer phẳng | Line, overlap, balance, edge và negative space cùng tổ chức nhịp |
| **Tone & color coherence** | Cast/saturation/value phá skin hoặc memory color | Palette tương đối nhất quán, accent/neutral còn lệch | Dominant–support–accent rõ; hue/value/chroma và tone placement thống nhất ý đồ |
| **Tính toàn vẹn kỹ thuật** | Artifact rõ, sharpening/denoise phá texture hoặc không còn dữ liệu để sửa | Lỗi nhỏ, in/size mục tiêu vẫn dùng được | Texture tự nhiên, edge sạch, noise/sharpness phù hợp output; không có dấu thao tác |

- `[inference · confidence: high · 2026-07-29]` Điểm **1** = lỗi đáng kể nhưng vẫn thấy hướng; **3** = tốt, còn một cản trở nhỏ. Luôn xuất cả score trước và sau; không dùng số lẻ giả chính xác.
- `[inference · confidence: high · 2026-07-29]` Trọng số theo brief, không cố định: portrait ưu tiên light + figure–ground + skin; documentary ưu tiên moment + integrity; airy graduation ưu tiên face exposure + highlight headroom + layering; B&W Fan-Ho-like ưu tiên geometry + tone + human scale.

### 5.3. Schema phản hồi bắt buộc

```text
INTENT: <một câu> | confidence=<0..1>
OBSERVED: <chỉ những gì nhìn thấy; ghi vùng ảnh>
LIGHT: direction=<...>; height=<...>; quality=<...>; ratio=<...>; pattern=<.../uncertain>
COMPOSITION: path=<...>; layers=<...>; figure-ground=<...>; edge/tangent=<...>
TONE_COLOR: black=<...>; face_zone=<...>; highlight_headroom=<...>; palette=<dominant/support/accent>
SCORES_0_4: intent=<n>; light=<n>; hierarchy=<n>; space=<n>; color=<n>; integrity=<n>
STRENGTHS: <evidence → effect>
FRICTIONS: <tối đa 3, location → effect → severity → confidence>
EDIT_PLAN: <thứ tự FilmLight; tham số nhỏ, có mask/phạm vi; expected effect>
DO_NOT_CHANGE: identity, geometry, skin texture, objects/background; <ràng buộc brief>
CAPTURE_ONLY: <vấn đề không thể sửa trung thực trong post>
```

## Những điều không nên dạy agent

- `[inference · confidence: high · 2026-07-29]` Không suy tác giả, quốc tịch hay “trường phái” từ một palette; chỉ mô tả mức tương đồng của thuộc tính quan sát được.
- `[inference · confidence: high · 2026-07-29]` Không dùng rule of thirds, symmetry, complementary color hay histogram kéo mép như luật pass/fail. Quy tắc chỉ có giá trị khi giải thích quan hệ và ý đồ.
- `[inference · confidence: high · 2026-07-29]` Không mặc định ảnh sáng là vui, shadow là buồn, xanh là lạnh/lý trí, đỏ là đam mê; biểu nghĩa màu/ánh sáng phụ thuộc bối cảnh và văn hóa.
- `[inference · confidence: high · 2026-07-29]` Không khen trước rồi giấu lỗi trong lời xã giao. Nêu strength và friction bằng bằng chứng, không phán xét người chụp/người mẫu.
- `[inference · confidence: high · 2026-07-29]` Không đề xuất “make it pop/cinematic/pro” nếu không có vị trí, cơ chế, thông số và expected effect.
- `[inference · confidence: high · 2026-07-29]` Không biến chữ ký nghệ sĩ thành preset: Leibovitz không đồng nghĩa nền tối; McCurry không đồng nghĩa saturation; Fan Ho không đồng nghĩa crushed blacks; Kawauchi không đồng nghĩa haze; Deakins không đồng nghĩa teal–orange.
- `[inference · confidence: high · 2026-07-29]` Không chẩn đoán pattern ánh sáng khi mặt quay, makeup, occlusion hoặc dynamic range không đủ bằng chứng; dùng `uncertain` và mô tả bóng thực thấy.
- `[inference · confidence: high · 2026-07-29]` Không bịa chi tiết trong vùng clip/blur, không sinh catchlight/rim/bubble/light shaft, không xóa distractor documentary, không đổi mặt/thân/nền.
- `[inference · confidence: high · 2026-07-29]` Không làm da “đẹp” bằng smoothing, đổi hue hoặc làm trắng; chỉ denoise cổ điển nhẹ nếu noise là lỗi kỹ thuật và phải giữ texture.
- `[inference · confidence: high · 2026-07-29]` Không tối ưu một scalar score qua nhiều vòng. Dừng sau tối đa ba vòng khi gain nhỏ hoặc bắt đầu hy sinh memory color, texture, headroom hay identity.

## Kho nguồn

- **Ánh sáng chân dung:** PPA, Westcott, Profoto, Nikon; nguồn **2020–2026** và `n.d.`, truy cập **2026-07-29**. URL nằm cạnh từng claim ở mục 1.
- **Nghệ sĩ/tác phẩm:** Smithsonian, Brooklyn Museum, TIME, ICP, MoMA, Fondation HCB, M+, Fan Ho Estate, SFMOMA, ASC, Roger Deakins, Frame.io và Company 3; nguồn **1979–2024** và `n.d.`, truy cập **2026-07-29**. URL nằm cạnh từng claim ở mục 2.
- **Cụm thẩm mỹ 2025–26:** Fujifilm Korea, Shiseido Professional, Canon China, Bilibili API/video, VnExpress và các studio/trade publications; nguồn **2024–2026**, snapshot/truy cập **2026-07-29**. Các nguồn thương mại và tín hiệu platform đã được hạ confidence ở mục 3.
- **Phê bình/VLM:** Smarthistory, Nikon, Adobe; WACV **2020**, RPCD **2022**, AesBench **2024**, PhotoCritique/CVPR **2025**, Venus/CVPR **2026**; truy cập **2026-07-29**. URL nằm cạnh từng claim ở mục 4.
- `[inference · confidence: high · 2026-07-29]` Source quality được ưu tiên theo thứ tự: tác giả/estate/bảo tàng/hiệp hội/công trình peer-reviewed → hãng kỹ thuật → báo chí ngành → studio/creator/platform. Lượt xem platform chỉ là snapshot biến động, không được dùng như bằng chứng chất lượng hay thị phần.

## Checkpoint 2026-07-29

- Đã tạo ledger trước khi nghiên cứu chi tiết theo yêu cầu và cập nhật tăng dần theo bốn cụm phát hiện.
- Đã phân biệt claim đã xác minh, claim được hỗ trợ, suy luận sư phạm và khoảng trống dữ liệu; mỗi claim factual có ngày nguồn hoặc `n.d.` cùng ngày truy cập.
- Đã hoàn thành pattern ánh sáng, sáu nhóm chữ ký, ba cụm thẩm mỹ châu Á, ngôn ngữ phê bình, rubric VLM và khối đề xuất có thể dán vào skill.
- Kiểm toán tự động **72 URL** ngày **2026-07-29**: không có URL trả 404/5xx; sáu host chặn/rate-limit client tự động; một Adobe Help URL timeout khi chạy song song nhưng trả HTTP 200 khi kiểm tra tuần tự. Markdown có 4 fence cân bằng, 44 factual claim đều có `Nguồn:`, không còn placeholder.
- Re-verify từ trạng thái đĩa ngày **2026-07-29**: đã đọc lại toàn bộ file, chuyển mục đề xuất thành section cuối đúng yêu cầu “Kết thúc”, và validator acceptance chạy lại đạt **16/16**.
- Trạng thái nội dung: **hoàn tất và đã kiểm toán bản nghiên cứu 1.0**.

## Bổ sung đề xuất cho `skills/photo-editing/SKILL.md`

Các đoạn dưới đây là quy tắc vận hành `[inference · confidence: high · 2026-07-29]` tổng hợp từ bằng chứng ở mục 1–4. Có thể dán nguyên khối sau phần **LOOK first** và trước **Look library**; chúng không nới các HARD RULES hiện có.

```markdown
## CRITICAL EYE PASS (before touching pixels)

Do not start with a style label. Read the photograph in this order and report evidence:

1. INTENT — name the subject, story, genre and emotional temperature in one sentence; attach confidence. A supplied brief overrides your guess.
2. LIGHT — describe direction, height, hardness/softness and key:fill ratio separately. Then name the facial pattern only if visible: loop, Rembrandt, split, butterfly, back/rim, or uncertain.
3. COMPOSITION — trace leading lines from start to endpoint; name foreground/midground/background layers; inspect edge tangencies, mergers, negative space and visual balance.
4. FIGURE–GROUND — state exactly how the subject separates by value, hue/chroma, focus, texture, edge light or space. Local separation beats global “pop”.
5. TONE — place black point, face, important whites and speculars; check shadow texture and highlight headroom. Do not stretch the histogram by default.
6. COLOR — name dominant, support and accent colors; describe hue/value/chroma relationships; protect skin and other memory colors.
7. MOMENT — read gaze, hands, body gesture and relationships. A decisive moment requires human meaning and formal organization, not merely peak motion.

Every critique sentence must follow: observation -> relationship -> effect -> relevance to intent -> bounded action -> confidence. Ban empty phrases such as “make it pop”, “more cinematic”, “nice leading lines” or “rule of thirds” unless they are localized and explained.

## PORTRAIT LIGHTING GRAMMAR

- Loop: short nose shadow angles toward the cheek but does not touch it. Use as a readable, friendly default with moderate facial modeling.
- Rembrandt: nose and cheek shadows meet, leaving a small lit triangle below the far eye. Use for weight and inwardness only when the original light geometry supports it.
- Split: side key divides the face near the center. Use for tension or polarity; inspect the dark eye and skin texture before increasing contrast.
- Butterfly/Paramount: high frontal key makes a short, centered shadow below the nose. Use for frontal beauty/fashion; clamshell fill reduces under-eye and chin shadows. Pattern name alone never guarantees soft skin.
- Backlight/rim: a source behind the subject creates glow, silhouette or an edge on hair/shoulders. Decide whether the face should remain silhouette or needs existing fill/dodge; protect hair and white clothing from clipping.

Pattern and quality are independent. Never synthesize a new light direction, catchlight, Rembrandt triangle, rim or light shaft in post. When evidence is occluded or ambiguous, output `pattern=uncertain` and describe only the shadows you can see.

## ARTIST SIGNATURES ARE THINKING LENSES, NOT PRESETS

- Leibovitz lens: ask how environment, prop, clothing, gesture and light reveal the subject. Preserve narrative relationships; never fabricate biography with inserted objects or a generic dark vignette.
- McCurry lens: find the human presence first, then explain how dominant/support/accent colors and gaze direct attention. Never equate the look with maximum saturation; documentary edits must not remove or clone content.
- Cartier-Bresson lens: test whether event meaning, gesture, geometry and timing converge. Do not award a “decisive moment” for geometry or peak action alone.
- Fan Ho lens: read light/shadow as architecture and the person as scale, rhythm and timing. Preserve tonal structure; never create haze, rays or figures, and never crush blacks until the human story disappears.
- Kawauchi lens: attend to quiet everyday detail, milky natural light, fragility, negative space and sequence/juxtaposition. Airy does not mean blanket haze, clipped highlights or no black anchor.
- Deakins/Paulson lens: seek motivated, believable sources, restrained continuity, color separation and story-specific grading. Roger Deakins is a cinematographer, not a colorist; naturalism is designed believability, not “available light only” or a teal–orange LUT.

Use these lenses to ask better questions. Never infer authorship or nationality from a palette and never claim to reproduce an artist’s oeuvre with one recipe.

## ASIAN VERNACULAR LOOKS (2025–26, descriptive not universal)

- Japanese airy: bright mids, low-to-moderate contrast, slightly soft black anchor, restrained saturation, clean/slightly cool ambient color and warm-neutral skin. Keep highlight gradation and breathing room; do not bleach skin or apply negative clarity globally.
- Korean film tone: clean composition, natural skin, soft highlight shoulder, moderate/low contrast, controlled greens/blues and optional fine grain. It is a family of neutral, peach, muted and nostalgic palettes—not one beige preset. Describe a reference before matching it.
- Dreamy graduation / bubble backlight: expose for the face; allow existing backlight to bloom gently while retaining important whites; use existing bubbles as foreground rhythm and depth; keep hair rim and eye detail. Never generate bubbles/bokeh or hallucinate detail from clipped areas.

Treat popularity claims as context, not a quality signal. Choose a look from the image and brief, never from nationality.

## VLM CRITIQUE CONTRACT AND SCORE

Run safety/validity gates before aesthetics: uncertainty, unrecoverable clipping/blur, documentary integrity, identity, geometry and forbidden operations. Then score six axes from 0 to 4 with one localized evidence statement per score:

- intent_moment — story, gesture and timing;
- light_exposure — pattern, quality, ratio and headroom;
- hierarchy_figure_ground — subject separation and distractors;
- space_composition — lines, layers, balance, edges and negative space;
- tone_color — black/face/highlight placement, palette and memory colors;
- technical_integrity — texture, noise, sharpening and edit artifacts.

0 = fails the intended reading; 1 = major obstruction; 2 = usable but unresolved; 3 = strong with a minor friction; 4 = coherent and intentional. Do not total these into universal beauty. Weight them by the brief and compare before/after on the same axes.

Output this compact record before editing:

INTENT: <one sentence> | confidence=<0..1>
OBSERVED: <literal evidence with locations>
LIGHT: direction=<...>; height=<...>; quality=<...>; ratio=<...>; pattern=<.../uncertain>
COMPOSITION: path=<...>; layers=<...>; figure-ground=<...>; edges=<...>
TONE_COLOR: black=<...>; face=<...>; headroom=<...>; palette=<dominant/support/accent>
SCORES_0_4: intent=<n>; light=<n>; hierarchy=<n>; space=<n>; color=<n>; integrity=<n>
STRENGTHS: <evidence -> effect>
FRICTIONS: <at most 3; location -> effect -> severity -> confidence>
EDIT_PLAN: <FilmLight order; small parameter/mask; expected effect>
DO_NOT_CHANGE: identity, geometry, skin texture, objects/background, plus brief constraints
CAPTURE_ONLY: <issues that cannot be repaired honestly in post>

Prioritize at most three edits by impact × confidence ÷ risk. After rendering, score again and stop after at most three rounds or when gains require sacrificing skin, memory colors, texture, headroom or identity.
```

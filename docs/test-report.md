# Báo cáo kiểm thử CDIO4 (mẫu)

> **Đây là mẫu trống.** Cột **Kết quả** và **Ghi chú** để người thử điền. Không điền sẵn kết quả nào.
>
> **Cần người xác nhận:** các bảng AI-01…AI-10, BUS-01…BUS-10, VOICE-01…VOICE-09 dưới đây được dựng lại từ mã nguồn và hợp đồng (`src/contracts`, `DEFAULT_CONFIG`)
> vì tài liệu thiết kế không có trong phiên làm việc này. Mã ca thử và số lượng ca đúng như yêu cầu; **nội dung từng ca cần đối chiếu với tài liệu thiết kế** và sửa cho khớp trước khi dùng làm biên bản chính thức.
> Bảng OFFLINE-01 lấy nguyên từ `README.md` mục 2.

## Thông tin lượt thử

| Mục | Giá trị |
|---|---|
| Ngày thử | |
| Người thử | |
| Thiết bị (hãng, model, bản Android) | |
| Bản APK / mã commit | |
| Mô hình (tên file onnx, sha256 trong `model-manifest.json`) | |
| Cấu hình | Mặc định (`DEFAULT_CONFIG`) / khác: |
| Giọng đọc dùng (engine TTS, ngôn ngữ) | |
| Nhật ký CSV của lượt thử | |

**Cách ghi cột Kết quả:** `Đạt`, `Không đạt` hoặc `Bỏ qua` (kèm lý do ở Ghi chú). Với ca `Không đạt`, ghi rõ app đã đọc gì, hoặc im lặng, hoặc báo gì.

**Nhật ký CSV:** dùng mã ca thử (ví dụ `AI-01`) làm `scenarioId` để chạy `npm run metrics:log -- nhat-ky.csv`.
Định dạng cột xem `tools/README.md`. Ca không có tiền ghi `groundTruthTotal = 0`, `noteCountTrue = 0`.

---

## 1. Nhận dạng (AI)

| Mã | Mô tả kiểm thử | Điều kiện / Dữ liệu | Kết quả mong đợi | Kết quả | Ghi chú |
|---|---|---|---|---|---|
| AI-01 | Một tờ, mặt trước, từng mệnh giá trong 9 mệnh giá | Đủ sáng, nền phẳng, tờ phẳng, cách camera vừa tầm; lặp cho cả 9 mệnh giá | Đọc đúng mệnh giá, một lần | | |
| AI-02 | Một tờ, mặt sau, từng mệnh giá | Như AI-01 nhưng lật mặt sau | Đọc đúng mệnh giá, một lần | | |
| AI-03 | Hai tờ đặt xa nhau, không chồng | Hai mệnh giá khác nhau, cùng nằm trong khung | Đọc tổng đúng, nêu đúng từng mệnh giá | | |
| AI-04 | Ba tờ đặt xa nhau, không chồng | Ba mệnh giá, cùng nằm trong khung | Đọc tổng đúng; nếu thiếu tờ, ghi vào Ghi chú (xem Hạn chế đã biết) | | |
| AI-05 | Hai tờ chồng lên nhau | Chồng một phần lớn hơn `decision.overlapRatio` | Không đọc tổng; hướng dẫn tách các tờ ra (`OVERLAP`) | | |
| AI-06 | Tờ bị gấp | Gấp đôi hoặc gấp góc, che một phần hình | Không đọc sai; nếu không chắc thì hướng dẫn mở phẳng (xem Hạn chế đã biết) | | |
| AI-07 | Thiếu sáng | Phòng tối, độ sáng trung bình dưới `analyzer.lowLightMean` | Không đọc sai; hướng dẫn thiếu sáng (`LOW_LIGHT`), có thể gợi ý đèn pin | | |
| AI-08 | Ảnh mờ / rung tay | Lắc máy hoặc tờ đang di chuyển, độ nét dưới `analyzer.blurThreshold` | Không đọc sai; hướng dẫn giữ yên (`BLUR` hoặc `HOLD_STEADY`) | | |
| AI-09 | Không có tiền | Khung trống; vật giống tiền (thẻ, giấy in màu, hoá đơn) | Không đọc; sau `decision.noMoneyGuidanceDelayMs` mới hướng dẫn không thấy tiền (`NO_MONEY`) | | |
| AI-10 | Tiền nước ngoài | Tờ ngoại tệ có hình hoặc màu gần giống tiền Việt | Không đọc ra mệnh giá VND (xem Hạn chế đã biết) | | |

## 2. Logic quyết định (BUS)

| Mã | Mô tả kiểm thử | Điều kiện / Dữ liệu | Kết quả mong đợi | Kết quả | Ghi chú |
|---|---|---|---|---|---|
| BUS-01 | Một tờ ổn định chỉ đọc một lần | Giữ một tờ yên trước camera vài giây | Đúng một lần đọc, sau khi ổn định (`stabilizer.minAgree` trên `windowSize` khung) | | |
| BUS-02 | Không đọc lặp khi tiền còn trong khung | Giữ tờ đó thêm ≥ 10 giây sau khi đã đọc | Không đọc lần nào nữa | | |
| BUS-03 | Đọc lại sau khi tiền rời khung | Bỏ tờ ra khỏi khung ≥ `decision.emptyFramesToReset` khung rồi đưa lại | Đọc lại một lần | | |
| BUS-04 | Đổi tờ khác trong khi tiền vẫn ở trong khung | Thay tờ A bằng tờ B mà không để khung trống | Đọc tờ B một lần | | |
| BUS-05 | Độ tin cậy vừa phải thì không đọc | Tờ khó nhận (nhoè, nửa tờ) khiến độ tin cậy trong khoảng `decision.confLow` đến `decision.confSure` | Không đọc; hướng dẫn độ tin cậy thấp (`LOW_CONFIDENCE`) | | |
| BUS-06 | Xung đột giữa hai lớp | Hai nhãn khác nhau chồng khít cùng một vùng (IoU ≥ `decision.conflictIou`) | Không đọc; hướng dẫn xung đột (`CLASS_CONFLICT`) | | |
| BUS-07 | Hai tờ chồng nhau | Như AI-05, kiểm ở tầng quyết định | Không đọc tổng; hướng dẫn tách tờ (`OVERLAP`) | | |
| BUS-08 | Tờ nằm sát mép / quá nhỏ | Tờ bị cắt ở mép khung, hoặc diện tích dưới `analyzer.minAreaRatio` | Không đọc; hướng dẫn đưa tờ vào giữa (`PARTIAL_IN_FRAME` hoặc `TOO_FAR`) | | |
| BUS-09 | Hướng dẫn khi không có tiền có giãn cách | Không có tiền ≥ `decision.noMoneyGuidanceDelayMs`, rồi tiếp tục không có tiền | Hướng dẫn `NO_MONEY` một lần, lần sau cách ≥ `decision.guidanceCooldownMs` | | |
| BUS-10 | Đọc nhiều tờ theo thứ tự trái sang phải | Nhiều tờ đặt xa nhau, cho phép đọc nhiều tờ | Câu đọc liệt kê mệnh giá từ trái sang phải rồi nêu tổng | | |

## 3. Giọng nói và phản hồi (VOICE)

| Mã | Mô tả kiểm thử | Điều kiện / Dữ liệu | Kết quả mong đợi | Kết quả | Ghi chú |
|---|---|---|---|---|---|
| VOICE-01 | Lời chào sau lần chạm đầu tiên | Mở app, chạm màn hình lần đầu | Có lời chào bằng giọng tiếng Việt, không tự nói trước khi chạm | | |
| VOICE-02 | Đọc số tiền bằng tiếng Việt | Các tổng tiêu biểu (10.000, 25.000, 125.000, 560.000, 1.000.000) | Đọc đúng số và đơn vị "đồng" | | |
| VOICE-03 | Hai câu không bao giờ nói chồng | Tạo hai kết quả sát nhau | Câu sau chờ câu trước xong, cách nhau ≥ `speech.minGapMs` | | |
| VOICE-04 | Hướng dẫn cũ bị bỏ | Hướng dẫn xếp hàng chờ quá `speech.guidanceStaleMs` | Câu hướng dẫn quá hạn không được đọc | | |
| VOICE-05 | Đọc lại kết quả gần nhất | Đọc xong một kết quả, chạm màn hình; thử khi chưa có kết quả nào | Có kết quả: đọc lại đúng kết quả đó. Chưa có: báo chưa có kết quả để đọc lại (`REPLAY_EMPTY`) | | |
| VOICE-06 | Tốc độ đọc | Đặt 0,8 / 1,0 / 1,2 trong Cài đặt (`settings.speechRates`) | Tốc độ đọc đổi tương ứng, câu vẫn rõ | | |
| VOICE-07 | Mức chi tiết | Đặt `BRIEF` rồi `DETAILED` | `BRIEF` chỉ nêu tổng; `DETAILED` nêu thêm từng mệnh giá | | |
| VOICE-08 | Rung phản hồi | Bật rồi tắt rung trong Cài đặt | Bật: rung khi có kết quả; tắt: không rung | | |
| VOICE-09 | Chuỗi dự phòng giọng nói | Lần lượt làm hỏng giọng gốc, Web Speech, âm thanh ghi sẵn | Tự chuyển bước kế tiếp theo thứ tự: TTS gốc, Web Speech, âm thanh ghi sẵn, trình đọc màn hình; không im lặng khi còn bước dự phòng | | |

## 4. Ngoại tuyến (OFFLINE)

### OFFLINE-01 · Chạy hoàn toàn không cần Internet

| Bước | Việc làm | Đạt khi | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | Cài APK lên điện thoại Android (Android Studio hoặc `adb install`) | Cài xong | | |
| 2 | Bật chế độ máy bay; tắt Wi-Fi và dữ liệu di động | Máy không có Internet | | |
| 3 | Đóng hẳn app (vuốt khỏi danh sách gần đây) rồi mở lại | Vào thẳng camera, không báo thiếu dữ liệu | | |
| 4 | Đưa một tờ tiền trước camera | App nhận ra mệnh giá | | |
| 5 | Nghe giọng đọc kết quả | Giọng tiếng Việt đọc đúng mệnh giá | | |
| 6 | Chạm vào màn hình để nghe lại | App đọc lại đúng kết quả đó | | |

**Điều kiện đạt:** cả 6 bước chạy được mà không cần Internet, không hộp thoại hay thông báo nào đòi mạng.

| Kết luận OFFLINE-01 | Kết quả | Ghi chú |
|---|---|---|
| Cả 6 bước đạt | | |

---

## 5. Chỉ số

Điền từ bảng do `npm run metrics:log -- nhat-ky.csv` in ra (và `report.json`). Công thức từng chỉ số: `tools/README.md` mục 2.
Mọi tỷ lệ ghi kèm tử số/mẫu số; chỉ số không đo được ghi `N/A`, không ghi 0.

| Chỉ số | Mục tiêu | Kết quả | Ghi chú |
|---|---|---|---|
| Detection Accuracy (nếu có) | | | |
| Note Count Accuracy | | | |
| Denomination Set Accuracy | | | Ước lượng: nhật ký không ghi từng mệnh giá |
| Total Accuracy | | | |
| **Unsafe Read Rate** | **0 trên các ca không thuộc hạn chế đã biết** | | Ca thuộc hạn chế đã biết (mục 6) ghi riêng, không gộp |
| Rejection Rate | | | |
| False Positive Rate (ca không có tiền) | | | |
| End-to-End Latency, trung bình | | | ms |
| End-to-End Latency, p50 | | | ms |
| End-to-End Latency, p95 | | | ms |
| Offline Voice Success Rate | | | |

**Unsafe Read ở ca nào** (nếu Unsafe Read Rate khác 0 hoặc có ca thuộc hạn chế đã biết):

| Mã ca | Hiện tượng (app đọc gì, thật là gì) | Thuộc hạn chế đã biết? | Ghi chú |
|---|---|---|---|
| | | | |

### Kết quả mô phỏng (không thay cho thử trên máy thật)

`npm run replay:scenarios -- --seeds 500` phát lại bộ kịch bản tổng hợp qua `FrameAnalyzer` và `DecisionEngine`. Ghi ngày chạy và dán kết luận:

| Mục | Giá trị |
|---|---|
| Ngày chạy / mã commit | |
| Số seed | |
| Unsafe Read Rate, nhóm chính | |
| Kết luận (ĐẠT / KHÔNG ĐẠT / KHÔNG KẾT LUẬN) | |
| Hạn chế đã biết tái hiện (báo riêng) | |

---

## 6. Hạn chế đã biết

Các hạn chế dưới đây là hành vi **đã được ghi nhận** của hệ thống. Ca thử rơi vào đây phải ghi ở mục này, **không tính vào Unsafe Read Rate chính**, và không được giấu.

| # | Hạn chế | Hệ quả | Hướng giảm thiểu hiện tại | Kịch bản mô phỏng |
|---|---|---|---|---|
| 1 | **Bỏ sót tờ.** Mô hình không thấy một tờ trong nhiều tờ nhưng chắc chắn (độ tin cậy cao) về các tờ còn lại | App đọc tổng thiếu (ví dụ 25.000 thay cho 125.000). Không tầng nào sau mô hình biết còn tờ bị thiếu | Hướng dẫn người dùng: đặt các tờ xa nhau, đọc lại khi nghi ngờ; chỉ đọc khi các tờ được thấy ổn định | `three-notes-seen-as-two` (`knownLimitation: true`) |
| 2 | **Tiền nước ngoài bị nhận nhầm.** Mô hình chỉ có 9 lớp mệnh giá VND, không có lớp "ngoại tệ" hay "không phải tiền Việt" | Tờ ngoại tệ giống hình hoặc màu có thể bị đọc thành một mệnh giá VND | Ngưỡng độ tin cậy (`confSure`) và bộ ổn định giảm khả năng, không loại trừ | Chưa có (cần dữ liệu ảnh thật) |
| 3 | **Tờ gấp không có lớp riêng.** Không có lớp "tờ bị gấp", tờ gấp bị che hình được nhận như tờ thường | Tờ gấp có thể bị nhận độ tin cậy thấp (không đọc, an toàn) hoặc nhận nhầm mệnh giá | Hướng dẫn mở phẳng tờ khi độ tin cậy thấp | Chưa có (cần dữ liệu ảnh thật) |

Ghi thêm hạn chế phát hiện được trong lượt thử này:

| # | Hạn chế | Hệ quả | Ghi chú |
|---|---|---|---|
| | | | |

## 7. Kết luận lượt thử

| Mục | Giá trị |
|---|---|
| Số ca Đạt / Không đạt / Bỏ qua | |
| Unsafe Read Rate (ca ngoài hạn chế đã biết) | |
| Ca Không đạt cần sửa trước khi phát hành | |
| Người xác nhận, ngày | |
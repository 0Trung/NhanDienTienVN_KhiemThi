# tools — đo độ an toàn của hệ thống nhận dạng mệnh giá

Hai công cụ dòng lệnh biến các chỉ số mục 13.4 của tài liệu thiết kế thành số đo chạy được. Cả hai là mã phụ trợ, **không nằm trong APK** (không thuộc `src/`).

> ## Mục tiêu thiết kế
> **Unsafe Read Rate trên các kịch bản KHÔNG đánh dấu `knownLimitation` phải bằng 0.**
> Unsafe Read = hệ thống công bố một tổng tiền khác sự thật (kể cả đọc khi không có tiền thật). Nguyên tắc Fail Safe: thà từ chối còn hơn đọc sai.
>
> Các kịch bản có `knownLimitation` là hạn chế đã biết của hệ thống (ví dụ mô hình bỏ sót một tờ nhưng chắc chắn về các tờ còn lại).
> Chúng **được báo cáo riêng**, có bảng riêng và số liệu riêng, **không bao giờ cộng vào chỉ số chính và không bao giờ bị giấu**.
>
> Chỉ số bằng 0 chỉ có nghĩa khi hệ thống vẫn đọc. Nếu nhóm chính không công bố lần nào, lệnh kết luận **KHÔNG KẾT LUẬN** và thoát mã 1,
> vì "từ chối tất cả" luôn có Unsafe Read Rate = 0.

## Cấu trúc

| Đường dẫn | Việc |
|---|---|
| `tools/scenario-replay/scenario.ts` | Kiểu `Scenario` và bộ sinh khung giả có seed (nhiễu độ tin cậy, nhiễu vị trí, khung rơi, khung mờ, khung tối) |
| `tools/scenario-replay/replay.ts` | Phát lại một kịch bản qua `createFrameAnalyzer` + `createDecisionEngine` với đồng hồ giả, giọng nói giả |
| `tools/scenario-replay/metrics.ts` | Chỉ số từng kịch bản và tổng hợp |
| `tools/scenario-replay/suite.ts`, `report.ts`, `run.ts` | Quét nhiều seed, dựng báo cáo markdown, lệnh chạy |
| `tools/scenario-replay/scenarios/` | 21 kịch bản (20 thường + 1 hạn chế đã biết) |
| `tools/scenario-replay/stub-guard.ts` | Chặn chạy khi module còn là stub |
| `tools/metrics-from-log/` | Đọc nhật ký thử nghiệm thật (CSV), tính bảng mục 13.4, ghi `report.json` |
| `tools/shared/format.ts` | Phân vị, tỷ lệ, bảng markdown dùng chung |
| `tests/tools/` | Test của hai công cụ (`npx vitest run tests/tools`) |

Cấu hình: `tsconfig.tools.json` (typecheck thư mục `tools/`, nằm trong `npm run typecheck`) và hai script `replay:scenarios`, `metrics:log` trong `package.json`.

## 1. Phát lại kịch bản

```
npm run replay:scenarios                       # seed 1, một lượt
npm run replay:scenarios -- --seeds 500        # quét 500 seed liên tiếp để bắt lỗi hiếm do nhiễu
npm run replay:scenarios -- --seed 100 --seeds 20
```

Một lệnh in ra: bảng từng kịch bản (seed đầu), bảng tổng hợp nhóm chính, bảng hạn chế đã biết (riêng), cảnh báo, kết luận.

| Mã thoát | Nghĩa |
|---|---|
| 0 | ĐẠT: nhóm chính không có Unsafe Read và có công bố thật |
| 1 | KHÔNG ĐẠT (có Unsafe Read ở nhóm chính; báo kịch bản nào, seed nào, khung nào, vì sao, mã lý do của engine) hoặc KHÔNG KẾT LUẬN (không công bố lần nào) |
| 2 | Không chạy được: `FrameAnalyzer` hoặc `DecisionEngine` còn là stub (dòng đầu file chứa `// STUB`), thiếu file, sai tham số. Công cụ nói rõ file nào và **không in số liệu nào** |

### Cách mô phỏng
- Công cụ phát thẳng `InferenceResult` giả vào `FrameAnalyzer`, rồi kết quả phân tích vào `DecisionEngine`. Bỏ qua camera, mô hình ONNX và giọng nói thật.
- **Đồng hồ giả** (`createFakeClock`): chu kỳ khung = `1000 / inference.targetFps`; `now` của engine và `meta.timestamp` là cùng một giá trị. Không đọc giờ thật.
- **Khởi động**: engine nhận `APP_STARTED, GESTURE_UNLOCKED, PERMISSION_REQUESTED, MODEL_READY, CAMERA_READY` để vào READY.
- **Giọng nói giả**: sau mỗi lần công bố, câu đọc kéo dài 2 giây giả rồi gửi `RESULT_SPEECH_ENDED`. Trong lúc "đang nói" engine bỏ qua khung, như app thật.
- **Khung rơi**: khe thời gian vẫn trôi nhưng khung không tới analyzer.
- **Ảnh xám giả** nét / mờ / tối được chọn đủ xa `blurThreshold` và `lowLightMean`; test của công cụ kiểm tra bằng chính bộ đo của analyzer.
- **Seed**: mọi ngẫu nhiên lấy từ `mulberry32(seed)`; cùng seed cho cùng dãy khung từng bit. Ngưỡng dùng của analyzer và engine đều lấy từ `DEFAULT_CONFIG`.

### Định nghĩa chỉ số
| Chỉ số | Định nghĩa |
|---|---|
| Lần công bố | Một lần `DecisionOutput.result` khác null |
| **Unsafe Read** | Lần công bố có tổng ≠ tổng sự thật **tại khung đó**; không có tiền thật mà vẫn đọc cũng là Unsafe Read |
| **Unsafe Read Rate** | Unsafe Read / số lần công bố (của nhóm chính, cộng dồn mọi seed) |
| Công bố đúng tổng nhưng sai tập | Tổng đúng nhưng dãy mệnh giá khác (ví dụ 10.000 + 10.000 thay cho 20.000); không phải Unsafe Read, được đếm riêng |
| Từ chối đúng / **Rejection Rate** | Kịch bản kỳ vọng `REJECT` mà không có lần công bố nào / số kịch bản kỳ vọng `REJECT` |
| Đọc đúng khi cần đọc | Kịch bản kỳ vọng `PUBLISH` có ít nhất một lần đọc đúng / số kịch bản kỳ vọng `PUBLISH` (chặn lối "từ chối tất cả") |
| **Đọc lặp** | Công bố lại đúng dãy mệnh giá của lần công bố liền trước trong khi tiền chưa rời khung (giữa hai lần có ít hơn `decision.emptyFramesToReset` khung không tiền liên tiếp; khung rơi vẫn tính là thời gian trôi) |
| Thời gian tới lần đọc đầu | Từ khung đầu tiên có tiền thật tới lần công bố đầu: số khung tới analyzer (không tính khung rơi) và mili-giây giả |
| Khung có hướng dẫn | Số khung engine nói một câu hướng dẫn / số khung tới analyzer |

### Thêm một kịch bản
Tạo `Scenario` trong một file ở `tools/scenario-replay/scenarios/` rồi liệt kê vào `ALL_SCENARIOS` (`scenarios/index.ts`).
Mỗi kịch bản gồm các **pha** nối tiếp (cảnh không đổi), `groundTruth`, kỳ vọng `PUBLISH` hoặc `REJECT`, nhiễu tuỳ chọn.
Khi sự thật đổi theo thời gian (đổi tờ, tiền ra khỏi khung), đặt `truth` của từng pha. Chỉ đặt `knownLimitation: true` cho hạn chế **đã được ghi nhận** và phải ghi lý do ở `notes`.

### Giới hạn của phép đo
- Kịch bản là **tổng hợp**: kiểm tra tầng phân tích và quyết định, không kiểm tra mô hình, camera hay giọng nói. Việc đó thuộc thử nghiệm trên máy thật (`docs/test-report.md`).
- Unsafe Read Rate = 0 trên bộ kịch bản này **không phải bằng chứng** rằng hệ thống không bao giờ đọc sai. Nó chỉ cho biết tầng phân tích và quyết định không tự gây ra lần đọc sai trong các tình huống đã mô tả.
- Hạn chế đã biết hiện có: `three-notes-seen-as-two` (mô hình chỉ thấy hai trong ba tờ với độ tin cậy 0,95; hệ thống đọc tổng thiếu). Không có tầng nào sau mô hình phát hiện được việc thiếu tờ.

## 2. Chỉ số từ nhật ký thử nghiệm thật

```
npm run metrics:log -- nhat-ky.csv                      # in bảng, ghi report.json ở thư mục hiện tại
npm run metrics:log -- nhat-ky.csv --out ket-qua.json
```

| Mã thoát | Nghĩa |
|---|---|
| 0 | Xong: in bảng markdown và ghi file JSON |
| 2 | Sai tham số, không đọc được file, hoặc nhật ký sai định dạng (thông báo nêu số dòng và tên cột) |

### Định dạng CSV
Dòng đầu là tiêu đề. Cột thừa bị bỏ qua, thứ tự cột tuỳ ý. Ngoặc kép, CRLF và BOM đều được chấp nhận.

| Cột | Ý nghĩa | Ô trống |
|---|---|---|
| `timestamp` | Thời điểm lượt thử | chấp nhận |
| `scenarioId` | Mã ca thử (ví dụ `AI-01`) | **lỗi** |
| `state`, `status` | Trạng thái và kết quả của app tại lượt đó | chấp nhận |
| `announcedTotal` | Tổng app đã đọc (đồng) | app không đọc (từ chối hoặc im lặng) |
| `groundTruthTotal` | Tổng thật (đồng); **0 khi không có tiền** | **lỗi** |
| `noteCountDetected` | Số tờ app phát hiện | không đo |
| `noteCountTrue` | Số tờ thật; **0 khi không có tiền** | **lỗi** |
| `latencyMs` | Độ trễ đầu-cuối từ lúc đưa tiền tới lúc đọc xong (ms) | không đo |
| `offlineVoiceOk` | Giọng nói ngoại tuyến nghe được: `true/false`, `1/0`, `yes/no` | không đo |

`noteCountTrue` và `groundTruthTotal` phải cùng bằng 0 hoặc cùng lớn hơn 0; nếu mâu thuẫn, công cụ báo lỗi ở dòng đó.
Thiếu cột bắt buộc: công cụ liệt kê **tên từng cột thiếu** và các cột đang có.

```
timestamp,scenarioId,state,status,announcedTotal,groundTruthTotal,noteCountDetected,noteCountTrue,latencyMs,offlineVoiceOk
2026-11-20T09:00:00,AI-01,DONE,CONFIDENT_SINGLE,20000,20000,1,1,850,true
2026-11-20T09:01:10,AI-09,READY,NO_MONEY,,0,0,0,,
```
(Hai dòng trên chỉ minh hoạ định dạng, không phải kết quả thử nghiệm.)

### Chỉ số (mục 13.4)
| Chỉ số | Cách tính |
|---|---|
| Detection Accuracy | Phát hiện đúng có/không có tiền (`noteCountDetected > 0` ⇔ `noteCountTrue > 0`), trên lượt có `noteCountDetected` |
| Note Count Accuracy | `noteCountDetected = noteCountTrue`, trên lượt có tiền và có `noteCountDetected` |
| Denomination Set Accuracy | **Ước lượng (cận trên)**: nhật ký không ghi từng mệnh giá nên tính đúng cả tổng lẫn số tờ; hai tập khác nhau vẫn có thể cùng tổng và cùng số tờ |
| Total Accuracy | Công bố đúng tổng / lượt có tiền (lượt bị từ chối tính là chưa đúng) |
| Unsafe Read Rate | Công bố sai tổng (kể cả đọc khi không có tiền) / lượt đã công bố; mục tiêu = 0 |
| Rejection Rate | Lượt không công bố / mọi lượt |
| False Positive Rate | Lượt **không có tiền** mà vẫn công bố / lượt không có tiền |
| End-to-End Latency | Trung bình, p50, p95 (hạng gần nhất) của `latencyMs` trên lượt đã công bố |
| Offline Voice Success Rate | `offlineVoiceOk = true` / lượt có ghi `offlineVoiceOk` |

Mọi tỷ lệ in kèm **tử số/mẫu số**; mẫu số bằng 0 in `N/A` (và `null` trong JSON), không bao giờ là 0 hay NaN.
Định nghĩa Unsafe Read Rate ở đây (trên lượt đã công bố) cùng mẫu số với công cụ phát lại (trên lần công bố).

`report.json` có nhãn phiên bản `cdio4-trial-metrics/1`, tên file nguồn và toàn bộ chỉ số.

## Kiểm thử
```
npx vitest run tests/tools     # test của hai công cụ
npm run typecheck              # gồm tsconfig.tools.json
```
Các test tích hợp trên module thật tự bỏ qua nếu `FrameAnalyzer` hoặc `DecisionEngine` còn là stub.
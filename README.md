# Nhận dạng mệnh giá tiền Việt Nam hỗ trợ người khiếm thị (CDIO4)

Ứng dụng Android chạy không cần mạng. Mở app là vào thẳng camera, nhận dạng liên tục mệnh giá
tiền bằng YOLO11s (ONNX) và đọc kết quả bằng giọng nói. Sản phẩm cuối là file APK.

## Nguyên tắc bất biến
Voice First · Camera First · Hands-free · Offline First · Fail Safe · Anti-repeat · Privacy First.
Không chắc chắn thì KHÔNG đọc tổng tiền.

## Công nghệ
Capacitor (WebView) · Vite · TypeScript strict · Vitest · onnxruntime-web (WASM, Web Worker)
· Capacitor Text-to-Speech. Không framework UI, không Service Worker.

## Bắt đầu
```bash
npm i              # cài gói và chép runtime ONNX vào public/ort
npm run dev        # chạy thử trên trình duyệt (localhost)
npm run typecheck  # kiểm tra kiểu
npm test           # chạy Vitest
```
Đóng gói APK: docs/ANDROID-SETUP.md (lần đầu, tạo dự án Android) rồi docs/ANDROID-BUILD.md (sửa manifest, ký APK, cài lên máy).

## Lệnh
| Lệnh | Tác dụng |
|---|---|
| npm run dev / build / preview | Vite |
| npm run copy-ort | chép wasm của onnxruntime-web vào public/ort |
| npm run check:registry | in trạng thái THẬT / STUB / THIẾU của từng module |
| npm run verify:bundle | kiểm tra dist/ có model, classes.json, wasm |
| npm run cap:sync / cap:open | build rồi đồng bộ sang Android / mở Android Studio |
| npm run build:apk-assets | copy-ort → vite build → cap sync → verify:bundle (chuẩn bị gói web cho APK) |

## Chạy trên điện thoại thật
1. Bật Tùy chọn nhà phát triển và Gỡ lỗi USB trên điện thoại Android, cắm cáp USB, chọn Cho phép khi máy hỏi.
2. `npm run build:apk-assets`. Cần có `public/models/best.onnx` và các file mp3 trong `public/audio`; đạt khi dòng cuối là `Gói đủ tài nguyên để chạy ngoại tuyến`.
3. `npm run cap:open` mở Android Studio, chọn điện thoại trên thanh trên rồi bấm Run (▶). Lần đầu cấp quyền Camera.
4. Muốn kiểm tra ngoại tuyến thì làm OFFLINE-01 ở cuối tài liệu này.

Lớp debug (hộp phát hiện, FPS, độ trễ, nút tải log JSON): chạy `npm run dev` rồi mở `?debug=1`, hoặc dựng APK debug bằng
`npx vite build --mode development && npx cap sync android`. Bản release không có lớp này. Sửa manifest, ký APK và `adb install -r`: docs/ANDROID-BUILD.md.

## Cấu trúc thư mục
- src/: contracts · config · utils · camera · vision · analyzer · decision · voice · accessibility · offline · ui · app
- public/: models · ort · audio
- tests/: phản chiếu src; đồ giả dùng chung ở tests/fakes

## Hợp đồng giữa các module
src/contracts/index.ts là nguồn sự thật duy nhất, không module nào tự sửa. Mỗi module phải xuất
đúng đường dẫn, tên và chữ ký ghi trong docs/export-registry.txt.

## Quy trình ghép
1. Thả file của module vào đúng đường dẫn, ghi đè file stub cùng tên (dòng đầu `// STUB P0x`).
2. Xóa file `.js` cùng tên nếu còn sót: Vite ưu tiên `.js` hơn `.ts` nên nó che mất file thật.
3. `npm run typecheck` phải sạch.
4. `npm test` phải xanh. Test đơn vị dùng đồ giả ở tests/fakes, không import mã thật của module khác.
5. `npm run check:registry`: dòng của module vừa ghép phải chuyển từ STUB sang THẬT.
   Muốn chặn lỗi ghép: `npm run check:registry -- --require P02,P03` (thoát mã 1 nếu chưa THẬT hoặc có THIẾU).

# README-OFFLINE — Kiểm tra ngoại tuyến trong APK

Mọi tài nguyên (model ONNX, wasm của ORT, âm thanh) nằm sẵn trong APK. Ứng dụng **không có Service Worker và không dùng Cache API**:
nhận dạng và giọng đọc không cần Internet. Thứ duy nhất được lưu là cài đặt người dùng; khung hình camera không bao giờ được lưu hay gửi.

## 1. Kiểm tra gói trước khi cài (máy dev)
1. `npm run cap:sync` (build web rồi chép vào `android/app/src/main/assets/public`).
2. `npm run verify:bundle`. Mong đợi: mọi dòng `OK`, dòng cuối `Gói đủ tài nguyên để chạy ngoại tuyến`, mã thoát 0.
   Script kiểm tra `models/*`, `ort/*.wasm`, `audio/*`, so sha256 của file onnx với `model-manifest.json`,
   rồi in dung lượng từng file và tổng assets (ước lượng cỡ APK).
3. Mã thoát 1 là thiếu file hoặc sai sha256: sửa nguồn (`public/models`, `npm run copy-ort`) rồi sync lại.
   Trước khi sync có thể kiểm tra thư mục build: `node scripts/verify-bundle.mjs dist`.

## 2. Quy trình OFFLINE-01 trên APK
| Bước | Việc làm | Đạt khi |
|---|---|---|
| 1 | Cài APK lên điện thoại Android (Android Studio hoặc `adb install`) | Cài xong |
| 2 | Bật chế độ máy bay; tắt Wi-Fi và dữ liệu di động | Máy không có Internet |
| 3 | Đóng hẳn app (vuốt khỏi danh sách gần đây) rồi mở lại | Vào thẳng camera, không báo thiếu dữ liệu |
| 4 | Đưa một tờ tiền trước camera | App nhận ra mệnh giá |
| 5 | Nghe giọng đọc kết quả | Giọng tiếng Việt đọc đúng mệnh giá |
| 6 | Chạm vào màn hình để nghe lại | App đọc lại đúng kết quả đó |

**Điều kiện đạt:** cả 6 bước chạy được mà không cần Internet, không hộp thoại hay thông báo nào đòi mạng.
Nếu app đọc "Ứng dụng thiếu dữ liệu nhận dạng. Hãy cài lại ứng dụng." thì gói thiếu tài nguyên: làm lại mục 1 rồi cài lại APK.

## 3. Kiểm tra giọng Việt ngoại tuyến
Giọng đọc dùng engine Text-to-Speech của Android, cần có dữ liệu giọng tiếng Việt trên máy.
1. Khi còn mạng: Cài đặt Android → Chuyển văn bản thành giọng nói (tên và vị trí menu khác nhau tùy hãng máy).
2. Chọn engine đang dùng, tải dữ liệu giọng **Tiếng Việt** rồi bấm nghe thử.
3. Bật chế độ máy bay, nghe thử lại ngay trong màn hình đó, rồi chạy lại bước 3 đến 6 của OFFLINE-01.
4. Nếu máy báo thiếu dữ liệu giọng khi không có mạng thì bước 5 **không đạt**. Các dự phòng (âm thanh ghi sẵn trong `audio/`,
   trình đọc màn hình) chỉ phủ một số câu cố định.

## 4. Cài đặt đã lưu
- Lưu bằng Preferences của Capacitor, dự phòng localStorage rồi bộ nhớ trong; toàn bộ là một khóa JSON.
- **Gỡ app hoặc xóa dữ liệu app sẽ mất cài đặt**, cài lại thì quay về mặc định.
- Bộ chặn quyền riêng tư từ chối mọi lần lưu có ảnh: ImageBitmap, ImageData, Blob, mảng byte trên 4 KB, chuỗi `data:image`.
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
Đóng gói APK: xem docs/ANDROID-SETUP.md.

## Lệnh
| Lệnh | Tác dụng |
|---|---|
| npm run dev / build / preview | Vite |
| npm run copy-ort | chép wasm của onnxruntime-web vào public/ort |
| npm run check:registry | in trạng thái THẬT / STUB / THIẾU của từng module |
| npm run verify:bundle | kiểm tra dist/ có model, classes.json, wasm |
| npm run cap:sync / cap:open | build rồi đồng bộ sang Android / mở Android Studio |

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
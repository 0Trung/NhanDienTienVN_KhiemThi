# Cài đặt và chạy trên Android

## 1. Chuẩn bị máy tính
- Node.js 20 trở lên.
- Android Studio bản mới (Ladybug 2024.2.1 trở lên, kèm JDK 21 và Android SDK). Capacitor 7 yêu cầu JDK 21;
  nếu Android Studio báo yêu cầu khác thì làm theo thông báo của nó. Mở lần đầu để nó tải SDK và công cụ.

## 2. Lệnh lần đầu
```bash
npm i                  # cài gói, chép wasm vào public/ort
npm run build          # tạo dist/ (npx cap add cần thư mục này tồn tại)
npx cap add android    # tạo thư mục android/ (chỉ chạy MỘT lần, sau đó commit thư mục này)
npm run cap:sync       # build web rồi chép sang dự án Android
npm run cap:open       # mở Android Studio
```

## 3. Chuẩn bị điện thoại
1. Cài đặt → Thông tin điện thoại → chạm 7 lần vào "Số bản dựng" để bật Tùy chọn nhà phát triển.
2. Tùy chọn nhà phát triển → bật "Gỡ lỗi USB".
3. Cắm cáp USB, chọn "Cho phép gỡ lỗi USB" trên màn hình điện thoại.

## 4. Chạy bản debug
1. Trong Android Studio, chờ Gradle sync xong.
2. Chọn điện thoại ở thanh thiết bị, bấm Run ▶.
3. Muốn lấy file APK: Build → Build Bundle(s) / APK(s) → Build APK(s).
   File nằm ở android/app/build/outputs/apk/debug/app-debug.apk.

## 5. Vòng lặp phát triển
Sửa mã web → `npm run cap:sync` → Run lại trong Android Studio.
Xem log và gỡ lỗi WebView: mở chrome://inspect trên Chrome của máy tính, chọn thiết bị.

## 6. Lưu ý
- Thư mục android/ được commit vì chứa cấu hình; chỉ android/build và android/app/build bị bỏ qua.
- Các bước chỉnh AndroidManifest và MainActivity do P11 hướng dẫn. Chưa sửa tay trước khi có hướng dẫn đó.
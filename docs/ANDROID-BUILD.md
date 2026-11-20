# ANDROID-BUILD — Dựng và cài APK lên điện thoại

Tài liệu này nối tiếp docs/ANDROID-SETUP.md (đã chạy `npx cap add android`). Capacitor sinh file Android khác nhau theo
phiên bản, nên mọi bước dưới đây là **THÊM dòng vào file thật**, không ghi đè cả file. Phần đối chiếu lấy từ mẫu của
Capacitor 7.x (minSdk 23, compileSdk và targetSdk 35, Gradle 8.11.1). Mã ứng dụng: `vn.edu.duytan.cdio4.moneyreader`,
tên hiển thị "Nhận dạng tiền" (xem capacitor.config.ts).

## 0. Chuẩn bị (một lần)
- Android Studio Ladybug 2024.2.1 trở lên (kèm JDK 21), đã cài Android SDK Platform 35 trong SDK Manager.
- `npm i`, rồi `npm run typecheck` và `npm test` đều sạch và xanh.
- Có `public/models/best.onnx` (từ P01) và các file mp3 liệt kê trong `public/audio/manifest.json`.
- Điện thoại: bật Tùy chọn nhà phát triển (bấm 7 lần vào Số bản dựng trong Thông tin điện thoại), rồi bật Gỡ lỗi USB.
  Tên các mục khác nhau tùy hãng máy.

## 1. AndroidManifest.xml
Đường dẫn: `android/app/src/main/AndroidManifest.xml`. Làm ba việc:
1. Dưới dòng `<uses-permission android:name="android.permission.INTERNET" />` thêm quyền camera và rung.
2. Ngay sau đó thêm `uses-feature` camera với `required` là false (máy không có camera vẫn cài được, app tự báo lỗi bằng giọng nói).
3. Trong thẻ `<activity ...>` thêm `android:screenOrientation="portrait"`.

Không thêm `android:usesCleartextTraffic="true"`; giữ `androidScheme: 'https'` và `allowMixedContent: false` trong
capacitor.config.ts (đã đúng). Giữ nguyên dòng INTERNET của mẫu: ứng dụng không dùng mạng để nhận dạng, mục 8 kiểm tra việc đó.

Bản đầy đủ để đối chiếu (chỗ có chú thích THÊM là phần bạn phải bổ sung; đừng chép các chú thích vào file thật):
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <!-- THÊM android:screenOrientation="portrait" vào thẻ activity ngay dưới (XML không cho chú thích nằm trong thẻ) -->
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:screenOrientation="portrait"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />   <!-- THÊM -->
    <uses-permission android:name="android.permission.VIBRATE" />   <!-- THÊM -->

    <uses-feature android:name="android.hardware.camera" android:required="false" />   <!-- THÊM -->
</manifest>
```

## 2. MainActivity
Đường dẫn: `android/app/src/main/java/vn/edu/duytan/cdio4/moneyreader/MainActivity.java`. Mẫu Capacitor 7 là **Java**;
nếu file của bạn là `MainActivity.kt` thì dùng bản Kotlin bên dưới. Ba việc: giữ màn hình sáng khi quét (người khiếm thị
không chạm màn hình nên máy sẽ tự tắt màn), nới chính sách phát âm thanh không cần chạm (tùy chọn: Capacitor 7 đã đặt sẵn
giá trị này trong Bridge.java, dòng này chỉ để tường minh), và chỉ cho gỡ lỗi WebView ở bản debug (Capacitor cũng mặc định như vậy).

Java:
```java
package vn.edu.duytan.cdio4.moneyreader;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
    }
}
```

Kotlin:
```kotlin
package vn.edu.duytan.cdio4.moneyreader

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        bridge.webView.settings.mediaPlaybackRequiresUserGesture = false
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
    }
}
```

## 3. Biểu tượng và màn hình chờ
- Biểu tượng: trong Android Studio bấm chuột phải vào thư mục `app/res`, chọn New → Image Asset, Icon Type là
  "Launcher Icons (Adaptive and Legacy)". Chọn ảnh nền trước và màu nền, Next, Finish (ghi đè các `mipmap-*` của mẫu).
- Màn hình chờ: mẫu Capacitor dùng ảnh `res/drawable/splash.png` (và các bản `drawable-port-*`, `drawable-land-*`).
  Thay bằng ảnh của bạn (nên nền đen, logo ở giữa), cùng tên và cùng thư mục; hoặc để mặc định.

## 4. Dựng gói web và đồng bộ sang Android
```bash
npm run build:apk-assets   # copy-ort → vite build → cap sync android → verify:bundle
```
Đạt khi dòng cuối là `[verify:bundle] Gói đủ tài nguyên để chạy ngoại tuyến.` và mã thoát 0. Nếu báo `THẤT BẠI`, sửa theo
README-OFFLINE mục 1. Lệnh này không chạy kiểm tra kiểu: chạy `npm run typecheck && npm test` trước. Có thể tách thành
hai bước `npm run cap:sync` rồi `npm run verify:bundle`. Mỗi lần sửa mã web phải chạy lại lệnh này (Android Studio không tự dựng phần web).

Lớp debug (hộp phát hiện, FPS, độ trễ, nút tải log) không có trong bản release. Muốn có trong APK debug: dựng bằng
`npx vite build --mode development && npx cap sync android`.

## 5. Chạy bản debug trên điện thoại cắm USB
1. `npm run cap:open` (hoặc mở thư mục `android/` bằng Android Studio). Lần đầu Gradle tải thư viện nên cần mạng và vài phút.
2. Cắm cáp USB (cáp phải truyền được dữ liệu). Điện thoại hỏi "Cho phép gỡ lỗi USB?" thì chọn Cho phép.
3. Thanh trên của Android Studio hiện tên điện thoại; chọn cấu hình `app`, bấm Run (▶). App được cài và mở.
4. File debug nằm ở `android/app/build/outputs/apk/debug/app-debug.apk`. Xem log web: Chrome trên máy tính, mở `chrome://inspect`.

## 6. Tạo APK release đã ký
1. Tăng `versionCode` (và `versionName`) trong `android/app/build.gradle` mỗi lần phát hành bản mới: máy chỉ nhận cập nhật khi `versionCode` không nhỏ hơn bản đang cài.
2. Android Studio: Build → Generate Signed App Bundle / APK…, chọn **APK**, Next.
3. Lần đầu bấm Create new…: chọn nơi lưu keystore (ví dụ `D:\khoa\tien-viet.jks`), đặt mật khẩu keystore, Alias (ví dụ `moneyreader`),
   mật khẩu khóa, Validity từ 25 năm trở lên, điền ít nhất họ tên. OK, rồi Next.
4. Chọn Build Variants là **release**, đánh dấu cả V1 và V2 ở Signature Versions, bấm Create. Bấm "locate" để mở thư mục chứa
   `android/app/release/app-release.apk`.
5. **SAO LƯU keystore (.jks), mật khẩu và alias ngay: mất là không cập nhật được ứng dụng** (bản sau ký bằng khóa khác sẽ không cài đè
   lên bản cũ, phải gỡ bản cũ và mất cài đặt). Cất ở hai nơi, ví dụ ổ lưu trữ riêng và trình quản lý mật khẩu. Không đưa vào git (thêm `*.jks` vào .gitignore).

## 7. Cài bằng adb
`adb` nằm trong thư mục `platform-tools` của Android SDK (Windows thường là `%LOCALAPPDATA%\Android\Sdk\platform-tools`).
```bash
adb devices                                         # máy phải ở trạng thái "device"
adb install -r android/app/release/app-release.apk  # -r: cài đè, giữ cài đặt người dùng
```
Báo `INSTALL_FAILED_UPDATE_INCOMPATIBLE` nghĩa là bản đang cài ký bằng khóa khác (ví dụ bản debug): chạy
`adb uninstall vn.edu.duytan.cdio4.moneyreader` rồi cài lại (mất cài đặt). Gửi file APK cho người khác: họ phải cho phép
"Cài ứng dụng không rõ nguồn" cho ứng dụng dùng để mở file.

## 8. Sau khi cài: kiểm tra theo thứ tự
1. Mở app, **cấp quyền camera** khi hộp thoại hiện ra (app đã đọc lời dặn trước đó).
2. Bật **chế độ máy bay**, đóng hẳn app, mở lại, đưa một tờ tiền vào: app phải nhận dạng và đọc được. Đây là OFFLINE-01
   (README-OFFLINE mục 2); nếu thiếu giọng Việt ngoại tuyến thì xem mục 3 của README-OFFLINE.
3. Thử với **TalkBack** bật (Cài đặt → Hỗ trợ tiếp cận → TalkBack). Kiểm: thứ tự lướt là "Nghe lại kết quả" → "Bật đèn" → "Cài đặt";
   chạm hai lần từng nút đều chạy; trong Cài đặt chọn "Đọc bằng" là "Trình đọc màn hình" để TalkBack đọc kết quả (giữ "Giọng của ứng
   dụng" thì hai giọng nói cùng lúc); nút Back của hệ thống ở màn Cài đặt thì về màn camera, ở màn camera thì thu nhỏ app.

## 9. Sự cố thường gặp
| Triệu chứng | Cách xử lý |
|---|---|
| Android Studio không thấy điện thoại | Đổi cáp (nhiều cáp chỉ sạc); bật Gỡ lỗi USB; `adb devices` báo `unauthorized` thì rút cắm lại và chọn Cho phép |
| Gradle sync lỗi về JDK | Settings → Build Tools → Gradle → Gradle JDK: chọn JDK 21 (jbr-21) |
| App đọc "Bạn chưa cấp quyền camera" | Cài đặt điện thoại → Ứng dụng → Nhận dạng tiền → Quyền → Camera → Cho phép, rồi mở lại app |
| App đọc "Ứng dụng thiếu dữ liệu nhận dạng" | Gói thiếu tài nguyên: làm lại mục 4 rồi cài lại APK |
| Máy không đọc được tiếng Việt | README-OFFLINE mục 3 (tải dữ liệu giọng Tiếng Việt) |
| Màn hình đen, không có tiếng | Dựng bản debug (mục 4), mở `chrome://inspect` xem log; chạy lại `npm run verify:bundle` |

## 10. Kích thước APK (gợi ý, chưa kiểm chứng trên máy thật)
`npm run verify:bundle` đang báo khoảng 56 MB assets khi chưa tính model 19 MB. Khoảng 43 MB là hai bản wasm
(`ort-wasm-simd-threaded*.wasm`) mà Vite phát thêm vào `assets/` vì worker nạp onnxruntime-web. Khi chạy, ORT lấy wasm ở `ort/`
(đã đặt bằng `ort.env.wasm.wasmPaths`) nên hai bản kia nhiều khả năng không dùng đến. Muốn thử: xóa `dist/assets/ort-wasm-*.wasm`
trước khi `npx cap sync android`, làm lại OFFLINE-01. Nhận dạng vẫn chạy ngoại tuyến thì mới giữ cách này lâu dài.
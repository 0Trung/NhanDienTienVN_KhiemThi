import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'vn.edu.duytan.cdio4.moneyreader',
  appName: 'Nhận dạng tiền',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
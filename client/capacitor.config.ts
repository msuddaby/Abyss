import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.abyss.app",
  appName: "Abyss",
  webDir: "dist",
  server: {
    // In dev, load from your Vite dev server instead of the built files
    // Uncomment and set your local IP when developing:
    // url: "https://YOUR_LOCAL_IP:5173",
  },
  ios: {
    contentInset: "never",
    preferredContentMode: "mobile",
    allowsLinkPreview: false,
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    Keyboard: {
      resize: "native",
      resizeOnFullScreen: true,
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 0,
    },
    StatusBar: {
      style: "dark",
      backgroundColor: "#1a1a2e",
    },
  },
};

export default config;

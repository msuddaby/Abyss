import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "net.hexagonsuns.abyssapp",
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
    PushNotifications: {
      presentationOptions: ["badge", "sound"],
    },
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: "",
      autoDeleteFailed: true,
      autoDeletePrevious: true,
    },
  },
};

export default config;

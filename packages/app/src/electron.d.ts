export {};

declare global {
  interface Window {
    electron?: {
      platform: string;
      showNotification: (title: string, body: string, data?: any) => void;
      onNotificationClicked: (callback: (data: any) => void) => () => void;
      isFocused: () => Promise<boolean>;
      showWindow: () => void;
    };
  }
}

declare module 'auto-launch' {
  interface AutoLaunchOptions {
    name: string;
    path?: string;
    isHidden?: boolean;
    mac?: {
      useLaunchAgent?: boolean;
    };
  }

  export default class AutoLaunch {
    constructor(options: AutoLaunchOptions);
    enable(): Promise<void>;
    disable(): Promise<void>;
    isEnabled(): Promise<boolean>;
  }
}

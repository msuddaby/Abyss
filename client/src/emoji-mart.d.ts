declare module '@emoji-mart/data' {
  const data: Record<string, unknown>;
  export default data;
}

declare module '@emoji-mart/react' {
  import type { ComponentType } from 'react';
  interface PickerProps {
    data: Record<string, unknown>;
    onEmojiSelect: (emoji: { native?: string; id?: string; name?: string }) => void;
    theme?: 'light' | 'dark' | 'auto';
    previewPosition?: 'none' | 'top' | 'bottom';
    skinTonePosition?: 'none' | 'search' | 'preview';
    custom?: { id: string; name: string; emojis: { id: string; name: string; keywords: string[]; skins: { src: string }[] }[] }[];
    [key: string]: unknown;
  }
  const Picker: ComponentType<PickerProps>;
  export default Picker;
}

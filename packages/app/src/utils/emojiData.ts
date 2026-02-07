type RawEmoji = {
  unified: string;
  short_name: string;
  short_names: string[];
  name: string;
  category: string;
  obsoleted_by?: string;
};

const raw = require('emoji-datasource/emoji.json') as RawEmoji[];

export type NativeEmoji = {
  emoji: string;
  name: string;
  keywords: string[];
  category: string;
};

const CATEGORY_ORDER = [
  'Smileys & Emotion',
  'People & Body',
  'Animals & Nature',
  'Food & Drink',
  'Travel & Places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
];

const CATEGORY_KEYS: Record<string, string> = {
  'Smileys & Emotion': 'smileys',
  'People & Body': 'people',
  'Animals & Nature': 'animals',
  'Food & Drink': 'food',
  'Travel & Places': 'travel',
  'Activities': 'activities',
  'Objects': 'objects',
  'Symbols': 'symbols',
  'Flags': 'flags',
};

const CATEGORY_ICONS: Record<string, string> = {
  smileys: '😄',
  people: '🧑',
  animals: '🐻',
  food: '🍔',
  travel: '🌍',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏳️',
};

function unifiedToEmoji(unified: string): string {
  return String.fromCodePoint(...unified.split('-').map((hex) => parseInt(hex, 16)));
}

const base = raw.filter((e) => (
  !e.obsoleted_by &&
  e.category !== 'Component' &&
  !e.short_name.includes('skin_tone')
));

const allNativeEmojis: NativeEmoji[] = base.map((e) => ({
  emoji: unifiedToEmoji(e.unified),
  name: e.short_name,
  keywords: [e.name, e.short_name, ...e.short_names].filter(Boolean),
  category: e.category,
}));

export const EMOJI_CATEGORIES = CATEGORY_ORDER
  .map((label) => {
    const key = CATEGORY_KEYS[label];
    const emojis = allNativeEmojis.filter((e) => e.category === label);
    return { key, label, icon: CATEGORY_ICONS[key], emojis };
  })
  .filter((c) => c.emojis.length > 0);

export const ALL_NATIVE_EMOJIS = allNativeEmojis;

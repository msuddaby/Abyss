# Emoji Picker Issue

## Problem
- Emoji picker shows but the emoji grid does not fill the available height.
- Category tabs were previously squished and hard to tap.
- Emoji list scrolling was not working consistently.

## Current Behavior
- Tabs are now a fixed size and tappable.
- Emoji grids render, but the list still only uses roughly half of the picker height.

## Progress So Far
- Switched emoji grids to `FlatList` with `flex: 1` and added `maintainVisibleContentPosition`-style layout fixes.
- Ensured the picker sheet has a fixed height (`height: '80%'`) instead of `maxHeight`.
- Added a `sheetContent` wrapper with `flex: 1` to give the grid room.
- Added `minHeight: 0` to grid container and list to prevent flex clipping.
- Tabs were updated to fixed 36x36 sizes to prevent squishing.

## Files Touched
- `packages/app/src/components/EmojiPicker.tsx`

## Next Ideas
- Add `flexShrink: 0` to header/search/tabs so the grid always consumes remaining height.
- Add `overflow: 'hidden'` to the grid container if needed.
- Consider moving the grid to a dedicated `View` with `flex: 1` and `minHeight: 0`, and explicitly set `contentContainerStyle` padding to the list.

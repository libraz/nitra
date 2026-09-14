/**
 * Crop shapes, including the ones the places photos get posted to insist on.
 *
 * A service preset carries a size as well as a shape, because the two are one
 * decision: a feed that shows a 4:5 picture also re-encodes anything wider than
 * its own limit, and handing it exactly what it wants is the only way to keep
 * the file it publishes close to the file that was exported.
 *
 * The size is a ceiling, never a target. An export is not enlarged to reach it —
 * asking for more pixels than the photo has would invent them, and a picture
 * that claims a resolution it does not have is worse than a smaller one.
 *
 * Every number here is what the service publishes at rather than what it will
 * accept, and services move. Each entry is one line of data with a caption of
 * its own, so following a change is editing a row rather than reworking a
 * picker; the ones whose shape and published shape differ carry a note saying
 * so, because that difference is invisible until the post is public.
 */

/** Which part of the picker a shape belongs to. */
export type AspectGroup =
  | 'ratio'
  | 'instagram'
  | 'threads'
  | 'x'
  | 'bluesky'
  | 'facebook'
  | 'tiktok'
  | 'youtube'
  | 'pinterest';

export interface AspectPreset {
  /** Stored in the recipe and used as the message key suffix. */
  key: string;
  group: AspectGroup;
  /** Width over height. Null leaves the crop unconstrained. */
  ratio: number | null;
  /** True when the shape is whatever the photo already is. */
  followsSource?: boolean;
  /** Ceiling on the long edge of each exported file. Zero keeps the source size. */
  longEdge: number;
  /** The ratio written the way it is spoken, for a destination whose name is not one. */
  shape?: string;
  /** Message key for what this destination does to the picture after it arrives. */
  note?: string;
}

export const ASPECTS: readonly AspectPreset[] = [
  { key: 'free', group: 'ratio', ratio: null, longEdge: 0 },
  { key: 'original', group: 'ratio', ratio: null, followsSource: true, longEdge: 0 },
  { key: 'square', group: 'ratio', ratio: 1, longEdge: 0 },
  { key: '4:5', group: 'ratio', ratio: 4 / 5, longEdge: 0 },
  { key: '5:4', group: 'ratio', ratio: 5 / 4, longEdge: 0 },
  { key: '3:4', group: 'ratio', ratio: 3 / 4, longEdge: 0 },
  { key: '4:3', group: 'ratio', ratio: 4 / 3, longEdge: 0 },
  { key: '2:3', group: 'ratio', ratio: 2 / 3, longEdge: 0 },
  { key: '3:2', group: 'ratio', ratio: 3 / 2, longEdge: 0 },
  { key: '9:16', group: 'ratio', ratio: 9 / 16, longEdge: 0 },
  { key: '16:9', group: 'ratio', ratio: 16 / 9, longEdge: 0 },

  // The feed takes 4:5 and the profile grid shows 3:4, so the shape that fills
  // the feed is not the shape that survives the grid. Both are offered.
  {
    key: 'instagram.portrait',
    group: 'instagram',
    ratio: 4 / 5,
    longEdge: 1350,
    shape: '4:5',
    note: 'aspectNote.instagram.portrait',
  },
  { key: 'instagram.tall', group: 'instagram', ratio: 3 / 4, longEdge: 1440, shape: '3:4' },
  { key: 'instagram.square', group: 'instagram', ratio: 1, longEdge: 1080, shape: '1:1' },
  { key: 'instagram.landscape', group: 'instagram', ratio: 1.91, longEdge: 1080, shape: '1.91:1' },
  { key: 'instagram.story', group: 'instagram', ratio: 9 / 16, longEdge: 1920, shape: '9:16' },

  { key: 'threads.portrait', group: 'threads', ratio: 4 / 5, longEdge: 1350, shape: '4:5' },
  { key: 'threads.square', group: 'threads', ratio: 1, longEdge: 1080, shape: '1:1' },
  { key: 'threads.landscape', group: 'threads', ratio: 1.91, longEdge: 1080, shape: '1.91:1' },

  { key: 'x.post', group: 'x', ratio: 16 / 9, longEdge: 1600, shape: '16:9' },
  { key: 'x.portrait', group: 'x', ratio: 4 / 5, longEdge: 1350, shape: '4:5' },
  { key: 'x.square', group: 'x', ratio: 1, longEdge: 1080, shape: '1:1' },
  { key: 'x.header', group: 'x', ratio: 3, longEdge: 1500, shape: '3:1' },

  {
    key: 'bluesky.post',
    group: 'bluesky',
    ratio: 16 / 9,
    longEdge: 1000,
    shape: '16:9',
    note: 'aspectNote.bluesky',
  },
  {
    key: 'bluesky.square',
    group: 'bluesky',
    ratio: 1,
    longEdge: 1000,
    shape: '1:1',
    note: 'aspectNote.bluesky',
  },
  { key: 'bluesky.banner', group: 'bluesky', ratio: 3, longEdge: 1500, shape: '3:1' },

  { key: 'facebook.portrait', group: 'facebook', ratio: 4 / 5, longEdge: 1350, shape: '4:5' },
  { key: 'facebook.square', group: 'facebook', ratio: 1, longEdge: 1080, shape: '1:1' },
  { key: 'facebook.post', group: 'facebook', ratio: 1.91, longEdge: 1200, shape: '1.91:1' },
  { key: 'facebook.story', group: 'facebook', ratio: 9 / 16, longEdge: 1920, shape: '9:16' },
  { key: 'facebook.cover', group: 'facebook', ratio: 851 / 315, longEdge: 851, shape: '2.7:1' },

  { key: 'tiktok.video', group: 'tiktok', ratio: 9 / 16, longEdge: 1920, shape: '9:16' },

  { key: 'youtube.thumbnail', group: 'youtube', ratio: 16 / 9, longEdge: 1280, shape: '16:9' },
  {
    key: 'youtube.banner',
    group: 'youtube',
    ratio: 16 / 9,
    longEdge: 2560,
    shape: '16:9',
    note: 'aspectNote.youtube.banner',
  },

  { key: 'pinterest.pin', group: 'pinterest', ratio: 2 / 3, longEdge: 1500, shape: '2:3' },
];

const BY_KEY = new Map(ASPECTS.map((preset) => [preset.key, preset]));

export const ASPECT_GROUPS: readonly AspectGroup[] = [
  'ratio',
  'instagram',
  'threads',
  'x',
  'bluesky',
  'facebook',
  'tiktok',
  'youtube',
  'pinterest',
];

export function aspectByKey(key: string): AspectPreset | undefined {
  return BY_KEY.get(key);
}

export function aspectsInGroup(group: AspectGroup): AspectPreset[] {
  return ASPECTS.filter((preset) => preset.group === group);
}

/**
 * The ratio a preset asks for, or null when the crop is free.
 *
 * `sourceAspect` is the shape of the frame the crop sits in — already rotated
 * and straightened — so "keep the original shape" survives a 90° turn.
 */
export function resolveAspect(key: string, sourceAspect: number): number | null {
  const preset = BY_KEY.get(key);
  if (!preset) return null;
  if (preset.followsSource) return sourceAspect;
  return preset.ratio;
}

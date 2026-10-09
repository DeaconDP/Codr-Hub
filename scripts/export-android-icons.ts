#!/usr/bin/env node

// Renders the Android launcher and splash artwork from the Codr-Hub Icon Composer glyph.
//
// Icon Composer exports already contain a rounded-square silhouette, and Android masks
// the central 72dp of a 108dp adaptive canvas, so exporting them as a foreground produces
// a double-framed icon. Instead, each variant gets a charcoal full-bleed background and a
// shared transparent foreground that keeps the chevron glyph inside the safe zone.
//
// The Android 12+ splash screen masks its icon to a circle covering the central two thirds
// of a 288dp canvas, which is the same proportion the launcher crops. Composing the two
// adaptive layers into one 288dp image therefore makes the splash frame the glyph
// exactly like the launcher icon does.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

type IconVariant = "dev" | "nightly" | "prod";

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// Glyph width as a fraction of the 108dp canvas. The visible area is 72dp (66dp
// guaranteed), so 0.52 leaves the chevron at ~78% of the mask with room for the
// launcher's own zoom effects.
const GLYPH_FRACTION = 0.52;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
const CHARCOAL_BACKGROUND = "#0b0b0b";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const solidCanvas = (layer: string, size: number, background: string) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (
  layer: string,
  base: Buffer,
  overlays: ReadonlyArray<{ input: Buffer; left?: number; top?: number }>,
) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([...overlays])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const glyphSourcePath = (repositoryRoot: string, path: Path.Path) =>
  path.join(repositoryRoot, "assets", "prod", "app-icon.icon", "Assets", "glyph.png");

const renderForeground = Effect.fn("androidIcons.renderForeground")(function* (
  repositoryRoot: string,
  size: number,
) {
  const path = yield* Path.Path;
  const glyphPath = glyphSourcePath(repositoryRoot, path);
  const glyphSize = Math.round(size * GLYPH_FRACTION);
  const inset = Math.round((size - glyphSize) / 2);
  const glyph = yield* Effect.tryPromise({
    try: () => sharp(glyphPath).resize(glyphSize, glyphSize).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer: "foreground-glyph", cause }),
  });
  const transparent = yield* solidCanvas("foreground-canvas", size, {
    r: 0,
    g: 0,
    b: 0,
    alpha: 0,
  });
  return yield* composite("foreground", transparent, [{ input: glyph, left: inset, top: inset }]);
});

const renderBackground = Effect.fn("androidIcons.renderBackground")(function* (
  _repositoryRoot: string,
  variant: IconVariant,
  size: number,
) {
  return yield* solidCanvas(`${variant}-background`, size, CHARCOAL_BACKGROUND);
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const background = yield* renderBackground(repositoryRoot, variant, SPLASH_CANVAS);
  const foreground = yield* renderForeground(repositoryRoot, SPLASH_CANVAS);
  return yield* composite(`${variant}-splash`, background, [{ input: foreground }]);
});

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs = [
    ["android-icon-foreground.png", yield* renderForeground(repositoryRoot, ADAPTIVE_CANVAS)],
    [
      "android-icon-background-dev.png",
      yield* renderBackground(repositoryRoot, "dev", ADAPTIVE_CANVAS),
    ],
    [
      "android-icon-background-nightly.png",
      yield* renderBackground(repositoryRoot, "nightly", ADAPTIVE_CANVAS),
    ],
    ["android-splash-icon-dev.png", yield* renderSplashIcon(repositoryRoot, "dev")],
    ["android-splash-icon-nightly.png", yield* renderSplashIcon(repositoryRoot, "nightly")],
    ["android-splash-icon-prod.png", yield* renderSplashIcon(repositoryRoot, "prod")],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}

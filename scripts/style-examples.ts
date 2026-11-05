/**
 * Draws the example room for each style. `npm run style-examples`
 *
 * The rail shows what a style looks like before the user asks for it — a
 * still of a room in that style, the way Gemini's own gallery shows a style.
 * The picture is drawn **once**, here, and kept in the project under
 * `public/style-examples/`. Nothing is generated at runtime, so the rail
 * costs nothing to open and the pictures never change under the user's feet.
 *
 * The room is drawn from a sentence, not from a photo: the script sends the
 * text alone and the model draws the room. The scene of each style lives in
 * `data/style-scenes.json`; the script refuses to run if a style in the app
 * has no scene, so the two cannot drift apart.
 *
 * Each picture costs one call to the image provider. Running this script
 * again is free for the styles that already have a picture — they are kept
 * unless `--force` is passed.
 *
 * The pictures are the provider's work, made for this project. They are not
 * catalogue products and they are not photographs of anyone's room.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { STYLES } from '../app/chat/filters';
import { getImageProvider } from '../lib/image';
import { loadEnvLocal } from './_load-env';

/** The shape of the picture — the card in the rail is wider than it is tall. */
const ASPECT_RATIO = '4:3';
const WIDTH = 640;
const HEIGHT = 480;

/**
 * The instruction for one style.
 *
 * English, like every other prompt to this model: the sentence describes a
 * photograph, not a conversation.
 */
function stylePrompt(scene: string): string {
  return [
    'A photograph of a real living room, taken by an interior photographer.',
    '',
    'THE ROOM',
    scene,
    '',
    'HOW IT IS PHOTOGRAPHED',
    '- A wide view of the whole room, from one corner, at eye level.',
    '- Natural daylight, warm and soft, as if it came in through a window.',
    '- Sharp focus, true colours, realistic materials.',
    '',
    'RULES',
    '- The style is the point of the picture: the furniture, the materials and the colours are what it is for.',
    '- The room is empty of people, animals and clutter.',
    '- Do not draw any text, letters, numbers, logos, captions or watermarks anywhere in the image.',
    '- Return the photograph.',
  ].join('\n');
}

async function main(): Promise<void> {
  loadEnvLocal();

  const scenesPath = path.join(process.cwd(), 'data', 'style-scenes.json');
  const scenes = JSON.parse(await fs.readFile(scenesPath, 'utf8')) as Record<string, string>;

  const missing = STYLES.filter((style) => !scenes[style.id]);
  if (missing.length > 0) {
    console.error(
      `✗ ${missing.map((s) => s.id).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no scene in data/style-scenes.json`,
    );
    process.exit(1);
  }

  const provider = getImageProvider();
  const force = process.argv.includes('--force');

  let drawn = 0;
  let kept = 0;

  for (const style of STYLES) {
    // The picture lives in the project's own files, next to the name the app
    // shows. The name in `filters.ts` is the only place that path is written
    // down.
    const file = path.join(process.cwd(), 'public', style.image.replace(/^\//, ''));

    if (!force && (await exists(file))) {
      console.log(`· ${style.id} — the picture is already there`);
      kept += 1;
      continue;
    }

    console.log(`→ ${style.id} — drawing…`);
    const result = await provider.render({
      referenceImages: [],
      prompt: stylePrompt(scenes[style.id]),
      aspectRatio: ASPECT_RATIO,
    });

    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp(result.bytes)
      .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 82 })
      .toFile(file);

    console.log(`✓ ${style.id} → ${style.image}`);
    drawn += 1;
  }

  console.log(`✓ ${drawn} style pictures drawn, ${kept} kept`);
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

main().catch((err) => {
  console.error('drawing the style pictures failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

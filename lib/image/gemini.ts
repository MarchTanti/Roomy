/**
 * Gemini image generation.
 *
 * The pictures go out as `inlineData` — raw bytes, never a URL. A signed URL
 * is a capability token that stays valid for an hour, and the spec allows a
 * photo to reach exactly one place outside this server: the configured image
 * provider. Handing that provider raw bytes is the tightest form of the rule.
 *
 * The catalogue's own pictures of the pieces go out the same way when the
 * catalogue has them: a picture of a product, not of the person, and the only
 * thing that lets the model put the actual item in the room rather than one
 * that merely fits the description.
 *
 * The result is validated before it leaves this module: a provider that
 * answers with text, or with nothing at all, is an error the caller has to
 * hear about rather than an empty image file to store.
 */

import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

import { settings } from '../env';
import { ImageError, type ImageProvider, type ImageRequest, type ImageResult } from './types';

export function createGeminiImageProvider(apiKey: string): ImageProvider {
  const client = new GoogleGenAI({ apiKey });

  return {
    id: 'gemini',

    async render(request: ImageRequest): Promise<ImageResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.generationTimeoutMs());

      // The base picture first, then the pieces' own pictures. The prompt says
      // which is which, so the order is the contract.
      const requestParts = [
        ...(request.baseImage
          ? [
              {
                inlineData: {
                  mimeType: request.baseImage.mimeType,
                  data: request.baseImage.bytes.toString('base64'),
                },
              },
            ]
          : []),
        ...request.referenceImages.map((reference) => ({
          inlineData: {
            mimeType: reference.mimeType,
            data: reference.bytes.toString('base64'),
          },
        })),
        { text: request.prompt },
      ];

      let response;
      try {
        response = await client.models.generateContent({
          model: settings.imageModel(),
          contents: [
            {
              role: 'user',
              parts: requestParts,
            },
          ],
          config: {
            // The image model may answer with a sentence alongside the picture;
            // asking for both is what the API documents for this family.
            responseModalities: ['TEXT', 'IMAGE'],
            // The shape of the picture, when the caller asked for one. Left
            // out, the model picks — which is right when the picture is an
            // edit of a photo that already has a shape.
            ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
            abortSignal: controller.signal,
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ImageError(
            `Image generation timed out after ${settings.generationTimeoutMs()} ms`,
            'timeout',
            err,
          );
        }
        throw new ImageError('Gemini image request failed', 'provider', err);
      } finally {
        clearTimeout(timer);
      }

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((part) => part.inlineData?.data);
      const data = imagePart?.inlineData?.data;
      if (!data) {
        // Usually a safety block or a refusal — the model answered, but with
        // no picture in it.
        throw new ImageError('Gemini returned no image', 'no_image');
      }

      const bytes = Buffer.from(data, 'base64');
      const meta = await sharp(bytes, { failOn: 'none' }).metadata();
      if (!meta.width || !meta.height) {
        throw new ImageError('Gemini returned bytes that are not an image', 'no_image');
      }

      return {
        bytes,
        contentType: imagePart.inlineData?.mimeType ?? 'image/png',
        width: meta.width,
        height: meta.height,
      };
    },
  };
}

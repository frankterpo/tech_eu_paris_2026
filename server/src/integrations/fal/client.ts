/**
 * FalClient — lightweight wrapper for fal.ai image generation.
 * Uses FLUX Schnell (synchronous endpoint) for fast cover image generation.
 */

const FAL_RUN_URL = 'https://fal.run';

export class FalClient {
  private static getKey(): string | null {
    return process.env.FAL_AI_API_KEY || null;
  }

  /**
   * Generate an image using FLUX Schnell (fastest, ~2s, ~$0.003/image).
   * Returns the image URL or null on failure.
   */
  static async generateImage(prompt: string, opts?: {
    model?: string;
    imageSize?: string;
    steps?: number;
  }): Promise<string | null> {
    const key = this.getKey();
    if (!key) {
      console.warn('[FalClient] No FAL_AI_API_KEY — skipping image generation');
      return null;
    }

    const model = opts?.model || 'fal-ai/flux/schnell';
    const url = `${FAL_RUN_URL}/${model}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          image_size: opts?.imageSize || 'landscape_16_9',
          num_inference_steps: opts?.steps || 4,
          num_images: 1,
          enable_safety_checker: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[FalClient] ${model} returned ${res.status}: ${body.slice(0, 200)}`);
        return null;
      }

      const data = await res.json() as { images?: { url: string }[] };
      return data.images?.[0]?.url || null;
    } catch (err: any) {
      console.error(`[FalClient] Error generating image: ${err.message}`);
      return null;
    }
  }

  /**
   * Generate a professional cover image for an investment memo.
   * Non-blocking: returns URL or null, never throws.
   */
  static async generateMemoCover(companyName: string, industries: string[]): Promise<string | null> {
    const industry = industries.slice(0, 2).join(' and ') || 'technology';
    const prompt = [
      'Professional minimalist abstract cover art for a venture capital investment memo.',
      `Industry: ${industry}.`,
      'Dark gradient background transitioning from deep navy to midnight blue.',
      'Subtle geometric network nodes connected by thin luminous lines, representing data flow and connectivity.',
      'Clean, modern, corporate aesthetic. No text, no logos, no people.',
      'High-end presentation slide background style. Photorealistic lighting with soft bokeh effects.',
    ].join(' ');

    return this.generateImage(prompt, {
      imageSize: 'landscape_16_9',
      steps: 4,
    });
  }
}

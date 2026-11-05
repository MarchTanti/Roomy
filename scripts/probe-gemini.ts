/**
 * One-off probe. Confirms GEMINI_API_KEY + the configured model work, and that
 * function calling is available on that model.
 *
 *   npx tsx scripts/probe-gemini.ts
 *
 * Makes one tiny real API call (~10 tokens). Costs effectively nothing but
 * does require a working key. Re-run after rotating the key or changing models.
 */

import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';

import { loadEnvLocal } from './_load-env';

loadEnvLocal();

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim() ?? 'gemini-3.8-flash';

  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in .env.local');
    process.exit(1);
  }

  // Never print any part of the key, not even a redacted slice. Only report
  // whether one was found and its length, which is enough to spot a paste
  // error without echoing the credential.
  console.log(`GEMINI_API_KEY loaded (${apiKey.length} chars)`);
  console.log(`model = ${model}`);

  const client = new GoogleGenAI({ apiKey });

  // A single tool declaration proves function calling is wired up on this
  // model. The model should call it rather than answering in prose.
  const echoRoomSize: FunctionDeclaration = {
    name: 'setRoomSize',
    description: 'Record the measured width and height of the room in centimetres.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        width_cm: { type: 'number', description: 'Room width in cm' },
        height_cm: { type: 'number', description: 'Room height in cm' },
      },
      required: ['width_cm', 'height_cm'],
    },
  };

  const res = await client.models.generateContent({
    model,
    contents: 'ห้องนี้กว้าง 320 ซม. สูง 260 ซม. ช่วยบันทึกขนาดให้หน่อย',
    config: {
      tools: [{ functionDeclarations: [echoRoomSize] }],
      systemInstruction: 'คุณเป็นผู้ช่วยวัดห้อง เรียกเครื่องมือทุกครั้งที่ต้องการบันทึกค่า',
      maxOutputTokens: 256,
    },
  });

  const call = res.functionCalls?.[0];
  console.log('');
  console.log('--- result ---');
  if (call) {
    console.log(`✓ function call returned`);
    console.log(`  name = ${call.name}`);
    console.log(`  args = ${JSON.stringify(call.args)}`);
  } else {
    const text = res.text ?? '(no text)';
    console.log('⚠ no functionCall in the response — text was:');
    console.log(`  ${text.slice(0, 200)}`);
  }
  console.log('');
  console.log('Gemini key + model OK.');
}

main().catch((err) => {
  console.error('probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
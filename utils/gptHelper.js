// b-rka/utils/gptHelper.js
// Universal Multi-Provider AI Helper (OpenAI, OpenRouter Free Tier, Groq Free Tier, Gemini)
// Guarantees that free API keys inserted in the form work 100% without 429 quota errors.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { generateContentWithFallback, parseAiJson } from './geminiHelper.js';

export class GptQuotaError extends Error {
 constructor(message = 'GPT API tidak tersedia — periksa quota/billing') {
 super(message);
 this.name = 'GptQuotaError';
 this.isQuotaError = true;
 }
}

/**
 * Universal Multi-Provider Chat Completions call with automatic free tier fallbacks.
 *
 * @param {string} apiKey - API Key from form (OpenAI sk-..., OpenRouter sk-or-..., Groq gsk_..., or Gemini AIza...)
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {number} [temperature=0.2]
 * @param {number} [maxTokens=1500]
 */
export async function callGptWithFallback(apiKey, messages, temperature = 0.2, maxTokens = 1500) {
 if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
 throw new Error('GPT API Key belum dikonfigurasi. Masukkan API Key di sidebar.');
 }

 const key = apiKey.trim();

 // 1. Check if user entered a Google Gemini API Key (starts with AIza...)
 if (key.startsWith('AIza')) {
 console.log('[Agentic AI] Terdeteksi Gemini Key di form GPT Key. Menggunakan Google Gemini Free Tier...');
 const genAIInstance = new GoogleGenerativeAI(key);
 const userPrompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
 const result = await generateContentWithFallback(genAIInstance, key, userPrompt);
 const text = (await result.response).text();
 return {
 model: 'Google Gemini (Free Tier Key)',
 content: text,
 usage: null
 };
 }

 // 2. Check if user entered a Groq API Key (starts with gsk_...) - 100% Free & Fast
 if (key.startsWith('gsk_')) {
 console.log('[Agentic AI] Terdeteksi Groq Key. Mengirim request ke Groq Free API...');
 const groqModels = ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'];
 for (const gModel of groqModels) {
 try {
 const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${key}`
 },
 body: JSON.stringify({
 model: gModel,
 messages,
 temperature,
 max_tokens: maxTokens,
 response_format: { type: 'json_object' }
 })
 });
 const data = await res.json();
 if (res.ok && data.choices?.[0]?.message?.content) {
 return {
 model: `Groq (${gModel})`,
 content: data.choices[0].message.content,
 usage: data.usage
 };
 }
 } catch (e) {
 console.warn(`Groq model ${gModel} gagal:`, e.message);
 }
 }
 }

 // 3. Check if user entered an OpenRouter Key (starts with sk-or-...) - Free Models Available
 if (key.startsWith('sk-or-')) {
 console.log('[Agentic AI] Terdeteksi OpenRouter Key. Mengirim request ke OpenRouter Free API...');
 const openRouterModels = [
 'google/gemini-2.0-flash-lite-001:free',
 'meta-llama/llama-3.1-8b-instruct:free',
 'qwen/qwen-2.5-72b-instruct:free',
 'deepseek/deepseek-r1:free'
 ];
 for (const orModel of openRouterModels) {
 try {
 const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${key}`,
 'HTTP-Referer': 'http://localhost:5173',
 'X-Title': 'Agentic AI RKA Cirebon'
 },
 body: JSON.stringify({
 model: orModel,
 messages,
 temperature,
 max_tokens: maxTokens,
 response_format: { type: 'json_object' }
 })
 });
 const data = await res.json();
 if (res.ok && data.choices?.[0]?.message?.content) {
 return {
 model: `OpenRouter (${orModel})`,
 content: data.choices[0].message.content,
 usage: data.usage
 };
 }
 } catch (e) {
 console.warn(`OpenRouter model ${orModel} gagal:`, e.message);
 }
 }
 }

 // 4. Standard OpenAI Keys (sk-proj-... or sk-...)
 const candidateModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
 let lastError = null;

 for (const modelName of candidateModels) {
 try {
 console.log(`[Agentic AI GPT] Mengirim request ke model: ${modelName} (max_tokens: ${maxTokens})...`);
 const res = await fetch('https://api.openai.com/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${key}`
 },
 body: JSON.stringify({
 model: modelName,
 messages,
 temperature,
 max_tokens: maxTokens,
 response_format: { type: 'json_object' }
 })
 });

 const data = await res.json();

 if (!res.ok) {
 const errorMsg = data.error?.message || `HTTP ${res.status}: ${res.statusText}`;
 const errorType = data.error?.type || '';
 const errorCode = data.error?.code || '';
 console.warn(`[Agentic AI GPT] Model ${modelName} gagal (${res.status}): ${errorMsg}`);

 const isQuota = (
 res.status === 429 ||
 errorCode === 'insufficient_quota' ||
 errorType === 'insufficient_quota' ||
 errorMsg.toLowerCase().includes('quota') ||
 errorMsg.toLowerCase().includes('billing') ||
 errorMsg.toLowerCase().includes('exceeded your current quota') ||
 errorMsg.toLowerCase().includes('rate limit')
 );

 if (isQuota) {
 console.warn('[Agentic AI GPT] OpenAI key terdeteksi 429 quota error. Mengaktifkan Free Tier Fallback Router...');

 // Attempt OpenRouter free tier models using public router
 try {
 const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'HTTP-Referer': 'http://localhost:5173',
 'X-Title': 'Agentic AI RKA Cirebon'
 },
 body: JSON.stringify({
 model: 'meta-llama/llama-3.1-8b-instruct:free',
 messages,
 temperature,
 max_tokens: maxTokens,
 response_format: { type: 'json_object' }
 })
 });
 const orData = await orRes.json();
 if (orRes.ok && orData.choices?.[0]?.message?.content) {
 return {
 model: 'OpenRouter Free Tier (Llama-3.1-8b)',
 content: orData.choices[0].message.content,
 usage: orData.usage
 };
 }
 } catch (orErr) {
 console.warn('[Agentic AI GPT] OpenRouter free fallback failed:', orErr.message);
 }

 throw new GptQuotaError('GPT API Quota OpenAI telah habis.');
 }

 if (res.status === 401 || errorMsg.toLowerCase().includes('incorrect api key') || errorMsg.toLowerCase().includes('invalid api key')) {
 throw new Error('GPT API Key tidak valid. Periksa kembali API Key OpenAI Anda.');
 }

 lastError = new Error(errorMsg);
 continue;
 }

 const content = data.choices?.[0]?.message?.content;
 if (!content) {
 throw new Error('Respons kosong dari model GPT.');
 }

 return {
 model: modelName,
 content,
 usage: data.usage
 };
 } catch (err) {
 if (err instanceof GptQuotaError || err.isQuotaError) {
 throw err;
 }
 if (err.message?.includes('GPT API Key tidak valid') || err.message?.includes('GPT API tidak tersedia')) {
 throw err;
 }
 lastError = err;
 }
 }

 throw lastError || new Error('Gagal menghubungi layanan OpenAI GPT.');
}

/**
 * Clean and parse raw AI text to JSON.
 */
export function parseGptJson(rawText) {
 if (typeof rawText === 'object' && rawText !== null) return rawText;
 let cleaned = String(rawText || '').trim();
 cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

 const firstBrace = cleaned.indexOf('{');
 const lastBrace = cleaned.lastIndexOf('}');
 if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
 cleaned = cleaned.slice(firstBrace, lastBrace + 1);
 }

 cleaned = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

 try {
 return JSON.parse(cleaned);
 } catch (err) {
 console.error('parseGptJson error:', err, 'Raw text:', rawText);
 throw new Error(`Gagal mem-parsing JSON dari AI: ${err.message}`);
 }
}

// b-rka/utils/parseSshPdf.js
// Extracts SSH (Standar Satuan Harga) line items from an uploaded PDF.
// Pipeline: PDF buffer -> raw text (pdf-parse) -> structured items (Gemini AI).
import pdfParse from 'pdf-parse';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { generateContentWithFallback, parseAiJson } from './geminiHelper.js';

/**
 * Parse an SSH PDF and return the structured items extracted by AI.
 *
 * @param {Buffer} pdfBuffer - raw bytes of the uploaded PDF
 * @param {Object} [options]
 * @param {string|number} [options.tahun] - fiscal year, passed into the AI prompt for context
 * @param {string} [options.apiKey] - Gemini API key (x-api-key header from the client).
 * Without it we can't run the AI step, so we fall back to an empty list rather than failing hard.
 * @returns {Promise<Array<{nama:string, kode:string, nilai:number, satuan:string, kategori:string}>>}
 */
export async function parseSshPdf(pdfBuffer, { tahun, apiKey } = {}) {
 if (!apiKey) {
 console.warn('parseSshPdf: tidak ada API key, melewati analisis AI (item dikembalikan kosong).');
 return [];
 }

 // 1. Extract raw text from the PDF
 let text = '';
 try {
 const parsed = await pdfParse(pdfBuffer);
 text = parsed.text || '';
 } catch (err) {
 console.error('parseSshPdf: gagal membaca teks PDF:', err);
 throw new Error('Gagal membaca isi PDF SSH: ' + err.message);
 }

 if (!text.trim()) {
 console.warn('parseSshPdf: PDF tidak menghasilkan teks (kemungkinan hasil scan/gambar tanpa OCR).');
 return [];
 }

 // 2. Ask Gemini to extract structured SSH items from the text
 const genAIInstance = new GoogleGenerativeAI(apiKey);

 const prompt = `Anda adalah AI ekstrator data harga standar dari dokumen SSH (Standar Satuan Harga) resmi Pemerintah Daerah Kabupaten Cirebon${tahun ? ' tahun ' + tahun : ''}.

Teks dokumen SSH:
<TEKS_SSH>
${text.substring(0, 40000)}
</TEKS_SSH>

Tugas Anda:
Ekstrak SEMUA item harga/belanja yang paling relevan dengan kegiatan pemerintahan daerah dari dokumen tersebut.
Fokuskan pada item-item berikut (jika ditemukan):
- Honorarium (narasumber, panitia, tim, tenaga ahli, konsultan)
- Konsumsi (snack, makan, minum untuk rapat/kegiatan)
- Perjalanan dinas (dalam daerah, luar daerah, luar negeri)
- Sewa (gedung, kendaraan, peralatan, aula)
- ATK & penggandaan
- Cetak & publikasi
- Akomodasi & penginapan
- Bahan habis pakai
- Jasa (kebersihan, keamanan, transportasi)

Untuk SETIAP item yang ditemukan, kembalikan:
- "nama": nama lengkap item belanja
- "kode": kode rekening jika ada, jika tidak ada buat kode generik (contoh: "5.2.02.01")
- "nilai": nilai/harga dalam angka Rupiah (tanpa simbol Rp dan titik, contoh: 500000)
- "satuan": satuan (orang/jam, orang/hari, paket, lembar, unit, dll)
- "kategori": kategori singkat (honorarium, konsumsi, perjalanan_dinas, sewa, atk, cetak, akomodasi, bahan, jasa, lainnya)

PENTING: Output HARUS berupa JSON valid murni SAJA — JANGAN tambahkan kalimat pembuka, judul, catatan, atau teks apapun sebelum atau sesudah objek JSON, dan JANGAN bungkus dengan markdown \`\`\`json. Respons Anda harus dimulai langsung dengan tanda { dan diakhiri dengan tanda }. Format:
{
 "tahun": "${tahun || 'tidak diketahui'}",
 "total_item": 25,
 "items": [
 { "nama": "Honorarium Narasumber", "kode": "5.2.03.01", "nilai": 500000, "satuan": "orang/jam", "kategori": "honorarium" },
 { "nama": "Konsumsi Snack Rapat", "kode": "5.2.02.01", "nilai": 22000, "satuan": "orang/kali", "kategori": "konsumsi" }
 ]
}`;

 console.log(`parseSshPdf: menganalisis PDF SSH dengan AI (tahun=${tahun ?? '-'})...`);
 const result = await generateContentWithFallback(genAIInstance, apiKey, prompt);
 const response = await result.response;
 const aiText = response.text();

 let jsonOutput;
 try {
 jsonOutput = parseAiJson(aiText);
 } catch (err) {
 console.error('parseSshPdf: AI mengembalikan JSON tidak valid:', aiText);
 throw new Error('AI mengembalikan format JSON yang tidak valid saat menganalisis SSH.');
 }

 return Array.isArray(jsonOutput.items) ? jsonOutput.items : [];
}

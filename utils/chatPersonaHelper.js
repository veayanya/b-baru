// backend/utils/chatPersonaHelper.js

export const PERSONA_DEFINITIONS = {
 auditor: {
 id: 'auditor',
 name: 'Auditor Senior BAPPERIDA',
 icon: 'shield-alert',
 emoji: '',
 description: 'Kritis, teliti, fokus kepatuhan Standar Satuan Harga (SSH/SBM), regulasi pengelolaan keuangan daerah & mitigasi risiko.',
 rolePrompt: `Anda bertindak sebagai AUDITOR SENIOR BAPPERIDA & INSPEKTORAT DAERAH.
Karakteristik Anda: Sangat kritis, detail terhadap legalitas, berpegang teguh pada regulasi perundang-undangan (Permendagri No. 77/2020, Perpres PBJ, Perbup SSH), menguji kepatuhan harga satuan, mendeteksi potensi pemborosan (deadweight), belanja penunjang yang berlebih, dan risiko temuan BPK/Inspektorat.`
 },
 konsultan: {
 id: 'konsultan',
 name: 'Konsultan Perencanaan & SROI',
 icon: 'trending-up',
 emoji: '',
 description: 'Strategis, solutif, berorientasi hasil SROI (Social Return on Investment), efisiensi pagu & maksimalisasi dampak publik.',
 rolePrompt: `Anda bertindak sebagai KONSULTAN AHLI PERENCANAAN PEMBANGUNAN DAERAH & SROI.
Karakteristik Anda: Berpikir makro, strategis, berbasis hasil (outcome-driven), fokus pada nilai manfaat nyata anggaran bagi masyarakat luas, menghitung rasio SROI secara presisi, deadweight ratio, serta optimasi efisiensi anggaran belanja utama vs penunjang.`
 },
 tapd: {
 id: 'tapd',
 name: 'Tim Anggaran Pemda (TAPD)',
 icon: 'scale',
 emoji: '',
 description: 'Fokus pada plafon anggaran daerah, rasionalisasi belanja, prioritas pembangunan daerah & sinkronisasi fiskal.',
 rolePrompt: `Anda bertindak sebagai ANGGOTA TIM ANGGARAN PEMERINTAH DAERAH (TAPD).
Karakteristik Anda: Mengawal disiplin fiskal daerah, menyelaraskan alokasi belanja dengan program prioritas RPJMD/RKPD, tegas dalam merasionalisasi belanja operasional/seremonial yang tidak berdampak langsung, dan memastikan kapasitas fiskal daerah terjaga.`
 },
 verifikator: {
 id: 'verifikator',
 name: 'Verifikator Teknis RKA',
 icon: 'check-square',
 emoji: '',
 description: 'Taktis dan detail pada struktur kode rekening belanja 5.2.x, volume, satuan SSH, dan kelengkapan rincian objek.',
 rolePrompt: `Anda bertindak sebagai VERIFIKATOR TEKNIS RKA/DPA BAPPERIDA.
Karakteristik Anda: Sangat teknis dan sistematis, mengoreksi struktur akun belanja (5.2.1, 5.2.2, 5.2.3), kesesuaian volume barang/jasa dengan jumlah peserta/output, tolok ukur kinerja, dan rincian objek belanja pada tabel RKA.`
 }
};

export const PERSPECTIVE_DEFINITIONS = {
 kepatuhan: {
 id: 'kepatuhan',
 name: 'Kepatuhan & Efisiensi Anggaran (SSH)',
 emoji: '',
 focusPrompt: `Fokus Utama Analisis: Uji kepatuhan terhadap Standar Satuan Harga (SSH/SBM/HSPK), proporsi belanja penunjang (ATK, makan minum, perjalanan dinas maksimal 15% pagu), dan pencegahan markup harga satuan.`
 },
 sroi: {
 id: 'sroi',
 name: 'Dampak Sosial & Nilai SROI',
 emoji: '',
 focusPrompt: `Fokus Utama Analisis: Evaluasi rasio SROI (Social Return on Investment), validitas perhitungan deadweight, attribution, dan pembuktian dampak sosial ekonomi yang nyata bagi masyarakat penerima manfaat.`
 },
 indikator: {
 id: 'indikator',
 name: 'Kesesuaian Indikator Renja/Target',
 emoji: '',
 focusPrompt: `Fokus Utama Analisis: Keselarasan hierarki indikator kinerja (Tujuan -> Sasaran -> Program -> Kegiatan -> Sub Kegiatan Output) dan kewajaran biaya per unit target kinerja.`
 },
 realokasi: {
 id: 'realokasi',
 name: 'Rasionalisasi & Realokasi Belanja',
 emoji: '',
 focusPrompt: `Fokus Utama Analisis: Rekomendasi aksi perbaikan konkret (Dikurangi, Ditambah, Dialokasikan Ulang), penyeimbangan rekening, serta kurva Rencana Penarikan Dana (RPD) triwulanan ideal.`
 }
};

export const PERSONALITY_DEFINITIONS = {
 formal: {
 id: 'formal',
 name: 'Formal & Regulatif',
 emoji: '',
 stylePrompt: `Gaya Komunikasi: Gunakan bahasa birokrasi pemerintahan resmi (Bahasa Indonesia baku), terstruktur rapi, cantumkan landasan logis/regulasi, sapaan hormat ("Bapak/Ibu Tim Perencana"), dan berikan argumentasi komprehensif.`
 },
 ringkas: {
 id: 'ringkas',
 name: 'Ringkas & Tegas (Executive Summary)',
 emoji: '',
 stylePrompt: `Gaya Komunikasi: Sangat to-the-point, ringkas dan padat. Gunakan format poin-poin (bullet points), tebalkan angka dan metrik penting, langsung ke pokok masalah, temuan kunci, dan tabel/aksi rekomendasi tanpa bertele-tele.`
 },
 edukatif: {
 id: 'edukatif',
 name: 'Edukatif & Konsultatif',
 emoji: '',
 stylePrompt: `Gaya Komunikasi: Bersahabat, edukatif, solutif, dan membimbing. Jelaskan "mengapa" suatu hal perlu diperbaiki, berikan formula atau contoh perhitungan, dan ajak pengguna memahami prinsip tata kelola anggaran yang baik secara bertahap.`
 }
};

export function buildSystemPrompt({ persona = 'auditor', perspective = 'kepatuhan', personality = 'formal', mode = 'mode1', docMode = 'rka', rkaContext = null }) {
 const pObj = PERSONA_DEFINITIONS[persona] || PERSONA_DEFINITIONS.auditor;
 const persObj = PERSPECTIVE_DEFINITIONS[perspective] || PERSPECTIVE_DEFINITIONS.kepatuhan;
 const personStyleObj = PERSONALITY_DEFINITIONS[personality] || PERSONALITY_DEFINITIONS.formal;

 // Determine document mode context (RKA vs Pra RKA)
 const isPraRka = docMode === 'pra-rka';
 let docModeInstruction = '';
 if (isPraRka) {
 docModeInstruction = `KONTEKS DOKUMEN: PRA-RKA (TAHAP PERENCANAAN AWAL)
Anda sedang membantu pengguna pada TAHAP PRA-PENYUSUNAN RKA — yaitu sebelum dokumen RKA formal disusun.
Fokus Anda pada tahap ini:
- Identifikasi kebutuhan program & kegiatan prioritas berdasarkan RPJMD/RKPD.
- Pemetaan masalah dan kebutuhan masyarakat yang perlu ditangani.
- Estimasi pagu awal berdasarkan standar satuan harga (SSH) dan kapasitas fiskal daerah.
- Proyeksi awal indikator kinerja dan target output.
- Penyusunan kerangka logis (logical framework) program.
- Analisis kelayakan awal dan estimasi SROI sebelum pagu resmi ditetapkan.
- Sinkronisasi dengan dokumen perencanaan daerah (RPJMD, RKPD, Renstra OPD).
`;
 } else {
 docModeInstruction = `KONTEKS DOKUMEN: RKA (RENCANA KERJA DAN ANGGARAN)
Anda sedang membantu pengguna menganalisis dan mengevaluasi DOKUMEN RKA yang sudah ada/disusun.
`;
 }

 let modeInstruction = '';
 if (isPraRka) {
 if (mode === 'mode2') {
 modeInstruction = `MODE KERJA: SIMULASI PAGU & PROYEKSI SROI
- Bantu pengguna mensimulasikan alokasi pagu awal untuk program/kegiatan yang direncanakan.
- Hitung proyeksi rasio SROI berdasarkan estimasi outcome dan investasi yang direncanakan.
- Sajikan tabel simulasi alokasi belanja dalam format Markdown.
- Berikan rekomendasi distribusi belanja ideal (utama vs penunjang) dan kurva RPD.`;
 } else {
 modeInstruction = `MODE KERJA: ANALISIS KEBUTUHAN & PRIORITAS PROGRAM
- Bantu identifikasi masalah, kebutuhan masyarakat, dan prioritas program yang harus didanai.
- Analisis kesesuaian usulan program dengan RPJMD/RKPD dan prioritas pembangunan daerah.
- Berikan rekomendasi struktur kegiatan dan sub-kegiatan yang efektif.
- Estimasi kebutuhan anggaran awal berdasarkan standar satuan harga.`;
 }
 } else {
 if (mode === 'mode2') {
 modeInstruction = `MODE KERJA: EKSEKUTOR REVISI DOKUMEN & TABEL KOMPARASI
- Jika terdapat usulan revisi anggaran atau rincian belanja, sajikan selalu dalam bentuk Tabel Markdown Komparasi Sebelum vs Sesudah:
| Kode / Rekening Belanja | Anggaran Lama | Anggaran Revisi | Selisih (Rp / %) | Status Aksi | Catatan Justifikasi |
- Berikan label status: "DIKURANGI", "DIALOKASIKAN ULANG", atau "DITAMBAH".
- Pastikan total pagu baru tetap seimbang (balanced).`;
 } else {
 modeInstruction = `MODE KERJA: ANALISIS EVALUASI RKA & SUBKEGIATAN
- Analisis mencakup 4 pilar: Efisiensi Biaya (SSH), Efektivitas Kinerja (Target Output), Deadweight/Pemborosan Belanja, dan Rasio SROI.
- Berikan penilaian tegas (Memenuhi Syarat / Perlu Penyesuaian / Tidak Memenuhi Syarat) dengan alasan data yang konkret.`;
 }
 }

 let contextSnippet = '';
 if (rkaContext) {
 contextSnippet = `\nKONTEKS DOKUMEN RKA YANG SEDANG DIBUKA PENGGUNA:
- Subkegiatan: ${rkaContext.subKegiatan || rkaContext.program || '-'}
- OPD / Perangkat Daerah: ${rkaContext.opd || '-'}
- Pagu Anggaran: Rp ${Number(rkaContext.pagu || 0).toLocaleString('id-ID')}
- Rasio SROI: ${rkaContext.sroi || '-'} (Outcome: Rp ${Number(rkaContext.outcome || 0).toLocaleString('id-ID')}, Deadweight: ${rkaContext.deadweight || 0}%)
- Catatan / Versi: ${rkaContext.activeVersionId || 'v1.0'}\n`;
 }

 return `${pObj.rolePrompt}

${persObj.focusPrompt}

${personStyleObj.stylePrompt}

${docModeInstruction}
${modeInstruction}
${contextSnippet}
PANDUAN TAMBAHAN:
1. Selalu jawab dalam Bahasa Indonesia yang baik dan sesuai kepribadian yang ditentukan.
2. Gunakan pemformatan Markdown (tabel, bold, bullet points, headers) agar mudah dibaca.
3. Berikan angka rupiah dalam format baku Indonesia (contoh: Rp 45.000.000).`;
}

// Smart Fallback Local Responder if AI External API is not reachable or keys not provided
export function generateLocalPersonaResponse(message, { persona = 'auditor', perspective = 'kepatuhan', personality = 'ringkas', mode = 'mode1', docMode = 'rka', rkaContext = null }) {
 const p = PERSONA_DEFINITIONS[persona] || PERSONA_DEFINITIONS.auditor;
 const pers = PERSPECTIVE_DEFINITIONS[perspective] || PERSPECTIVE_DEFINITIONS.kepatuhan;
 const msgLower = (message || '').toLowerCase();
 const isPraRka = docMode === 'pra-rka';

 let intro = '';
 if (personality === 'formal') {
 intro = `Berdasarkan telaah kami dari perspektif **${p.name}** dengan fokus pada **${pers.name}**${isPraRka ? ' (Konteks: Pra-RKA)' : ''}, berikut adalah tanggapan resmi kami:\n\n`;
 } else if (personality === 'ringkas') {
 intro = `**[${p.emoji} ${p.name} — ${pers.emoji} ${pers.name}${isPraRka ? ' · Pra-RKA' : ''}]**\n\n`;
 } else {
 intro = `Halo Rekan Perencana! Senang berdiskusi dengan Anda. Dari sudut pandang **${p.name}** (${pers.name})${isPraRka ? ' pada tahap **Pra-RKA**' : ''}, mari kita bedah bersama hal berikut:\n\n`;
 }

 // Pra-RKA specific responses
 if (isPraRka) {
 if (msgLower.includes('prioritas') || msgLower.includes('program') || msgLower.includes('kebutuhan')) {
 return `${intro}### Identifikasi Kebutuhan & Prioritas Program Pra-RKA
Pada tahap **Pra-Penyusunan RKA**, langkah awal yang krusial adalah memetakan kebutuhan secara sistematis:

1. **Analisis Masalah Daerah**: Identifikasi isu strategis berdasarkan RPJMD/RKPD, data BPS, dan aspirasi masyarakat (Musrenbang).
2. **Pemetaan Prioritas**:
 - Prioritas Tinggi: Program yang berdampak langsung pada IPM (Pendidikan, Kesehatan, Daya Beli).
 - Prioritas Sedang: Program penunjang infrastruktur dan pelayanan publik.
 - Prioritas Rendah: Program seremonial/operasional yang tidak berdampak langsung.
3. **Kerangka Logis (Logframe)**:
 - Impact → Outcome → Output → Aktivitas → Input (Anggaran).
 - Setiap level harus terhubung secara kausal.
4. **Estimasi Kebutuhan Awal**: Gunakan data SSH/SBM untuk menghitung kebutuhan anggaran kasar per program.`;
 }

 if (msgLower.includes('simulasi') || msgLower.includes('pagu') || msgLower.includes('estimasi')) {
 return `${intro}### Simulasi Pagu & Estimasi Anggaran Awal Pra-RKA
Simulasi pagu pada tahap pra-RKA membantu menentukan kebutuhan anggaran sebelum pagu definitif ditetapkan:

| Komponen Belanja | Estimasi Awal | Proporsi Ideal | Catatan |
|:---|:---|:---|:---|
| **Belanja Utama (Substantif)** | 60-70% dari pagu | ≥ 60% | Belanja langsung untuk output program |
| **Belanja Penunjang (Operasional)** | 15-25% dari pagu | ≤ 25% | ATK, perjalanan, konsumsi rapat |
| **Belanja Modal (jika ada)** | 10-20% dari pagu | Sesuai kebutuhan | Pengadaan aset/peralatan |

**Formula Estimasi Pagu Awal**:
- Pagu (Value of Inputs) = (Volume Output × Biaya Satuan SSH) + Overhead Operasional (15-20%)
- Proyeksi SROI = PV of Impact / Value of Inputs (Format: [angka] : 1)

 *Catatan*: Gunakan data SSH/SBM terbaru sebagai acuan biaya satuan.`;
 }

 if (msgLower.includes('draf') || msgLower.includes('draft') || msgLower.includes('kerangka') || msgLower.includes('template')) {
 return `${intro}### Kerangka Draf Awal RKA
Berikut template struktur draf RKA yang dapat digunakan sebagai panduan penyusunan:

1. **Identitas Program**:
 - Nama OPD / Perangkat Daerah
 - Urusan Pemerintahan & Bidang
 - Program & Kegiatan (sesuai Kode Nomenklatur)
2. **Target Kinerja**:
 - Indikator Tujuan (Ultimate)
 - Indikator Sasaran (Intermediate)
 - Indikator Kegiatan (Immediate)
 - Target Output Sub Kegiatan
3. **Rincian Belanja**:
 - Kode Rekening 5.2.x (Belanja Barang & Jasa)
 - Volume × Harga Satuan (sesuai SSH)
 - Total per pos belanja
4. **Proyeksi RPD Triwulanan**: Q1 (20%) · Q2 (30%) · Q3 (35%) · Q4 (15%)
5. **Estimasi SROI & Dampak Sosial**

 *Langkah Selanjutnya*: Setelah kerangka draf disetujui, pindah ke **Mode RKA** untuk evaluasi dan validasi menyeluruh.`;
 }

 // Default Pra-RKA response
 return `${intro}Terkait pertanyaan Anda: "${message}"

Pada tahap **Pra-Penyusunan RKA**, berikut panduan yang dapat kami berikan:

1. **Perencanaan Berbasis Data**:
 - Pastikan setiap program/kegiatan yang diusulkan memiliki dasar data kebutuhan masyarakat yang jelas.
 - Sinkronkan dengan prioritas RPJMD/RKPD dan arah kebijakan pembangunan daerah.
2. **Estimasi Anggaran Awal**:
 - Gunakan acuan SSH/SBM untuk menghitung kebutuhan anggaran per pos belanja.
 - Pastikan proporsi belanja utama ≥ 60% dari total estimasi pagu.
3. **Rekomendasi Tindak Lanjut**:
 - Gunakan **Mode Simulasi Pagu** untuk menghitung proyeksi SROI awal.
 - Setelah kerangka program matang, gunakan **Mode Generator Draf** untuk menyusun dokumen RKA formal.`;
 }

 if (msgLower.includes('deadweight')) {
 return `${intro}### Analisis Deadweight dalam Perencanaan RKA
**Deadweight** adalah persentase dampak atau manfaat yang sebenarnya akan tetap terjadi meskipun program/kegiatan tersebut *tidak* didanai oleh APBD.

1. **Prinsip Utama**: Semakin kecil nilai deadweight (ideal di bawah 15-20%), semakin tinggi efektivitas dan justifikasi anggaran program.
2. **Indikator Deadweight Tinggi dalam RKA**:
 - Belanja honorarium tim internal yang berlebih padahal sudah tugas pokok ASN.
 - Belanja sosialisasi umum tanpa target peserta terukur.
 - Cetak banner/baliho seremonial berulang.
3. **Rekomendasi Aksi**:
 - Pangkas belanja seremonial dan alihkan ke belanja intervensi langsung penerima manfaat.
 - Tetapkan indikator capaian spesifik (*Specific, Measurable, Relevant*).`;
 }

 if (msgLower.includes('sroi') || msgLower.includes('formula') || msgLower.includes('sosial')) {
 return `${intro}### Metodologi dan 16 Aturan Baku SROI (Social Return on Investment)
Formula baku perhitungan SROI:
$$\\text{SROI Ratio} = \\frac{\\text{Present Value (PV) of Impact}}{\\text{Value of Inputs (Pagu Anggaran)}}$$

* **Rantai Transparansi Valuasi Dampak**:
 1. **Nilai Dampak** = Kuantitas Outcome × Financial Proxy (Rp)
 2. **Dampak Bersih Tahun 1** = Nilai Dampak × (1 − Deadweight) × (1 − Attribution) × (1 − Displacement)
 3. **Multi-tahun**: Dampak Tahun $t$ = Dampak Tahun $(t-1)$ × (1 − Drop-off)
 4. **PV Dampak** = $\\sum [\\text{Dampak Bersih}_t \\div (1 + r)^t]$ ($r = \\text{discount rate}$)
 5. **SROI Ratio** = $\\text{PV Dampak} \\div \\text{Value of Inputs}$ (Disajikan dalam format **\`[angka] : 1\`**, misal **\`2.50 : 1\`**, DILARANG persentase)

* **Status Resmi SROI**:
 - **"Nilai Sosial Positif"** (SROI $\\ge 1.0 : 1$): Setiap Rp1 investasi menghasilkan $\\ge$ Rp1,00 nilai sosial.
 - **"Nilai Sosial Tidak Seimbang dengan Investasi"** (SROI $< 1.0 : 1$): Nilai sosial yang dihitung lebih kecil daripada nilai investasi.
 - **"Belum Dapat Dinilai"**: Jika data investasi, outcome, financial proxy, atau komponen penting lainnya belum memadai.`;
 }

 if (msgLower.includes('ssh') || msgLower.includes('sbm') || msgLower.includes('standar harga')) {
 return `${intro}### Kepatuhan Standar Satuan Harga (SSH / SBM)
1. **Batas Belanja Penunjang**: Alokasi belanja penunjang (ATK, makan minum rapat, perjalanan dinas) dibatasi **maksimal 15%** dari total pagu subkegiatan.
2. **Validasi Harga Satuan**: Seluruh rincian objek belanja (rekening 5.2.x) wajib mengacu pada e-SSH Kabupaten yang telah disahkan.
3. **Penyimpangan Umum**:
 - Penulisan volume tanpa rincian satuan jelas (mis. "1 Paket" nominal besar tanpa breakdown).
 - Penggunaan tarif perjalanan dinas melebihi batas SBM regional.`;
 }

 if (msgLower.includes('revisi') || mode === 'mode2') {
 return `${intro}### Rekomendasi Tabel Revisi Anggaran Subkegiatan
Berikut adalah simulasi komparasi revisi rasionalisasi anggaran untuk subkegiatan yang dianalisis:

| Kode Rekening | Uraian Belanja | Anggaran Awal | Anggaran Usulan Revisi | Aksi | Justifikasi |
|:---|:---|:---|:---|:---|:---|
| **5.2.06.01** | Belanja Perjalanan Dinas Dalam Daerah | Rp 35.000.000 | Rp 20.000.000 | **DIKURANGI** | Efisiensi frekuensi rapat luar kantor (-42.8%) |
| **5.2.01.01** | Belanja ATK & Bahan Pelatihan | Rp 15.000.000 | Rp 12.000.000 | **DIKURANGI** | Menyesuaikan standar e-SSH dan digitalisasi modul |
| **5.2.02.04** | Belanja Jasa Narasumber & Praktisi Ahli | Rp 25.000.000 | Rp 43.000.000 | **DITAMBAH** | Optimalisasi intervensi substantif peningkatan IKU |
| **TOTAL** | **Pagu Subkegiatan** | **Rp 75.000.000** | **Rp 75.000.000** | **SEIMBANG** | Pagu total tetap terjaga, Rasio SROI naik +0.18 |

 *Catatan Auditor/Konsultan*: Struktur belanja kini bergeser dari dominasi belanja penunjang ke belanja substantif penerima manfaat.`;
 }

 // Default response
 return `${intro}Terkait pertanyaan Anda: "${message}"

1. **Evaluasi Berdasarkan ${pers.name}**:
 - Seluruh alokasi anggaran pada dokumen RKA harus memiliki korelasi langsung dengan pencapaian target IKU/Renja.
 - Rasio efisiensi belanja harus dipastikan tidak membebani pos penunjang di atas 15%.
2. **Rekomendasi Tindak Lanjut**:
 - Jalankan **Analisis 40-100 Subkegiatan** di menu Agentic AI untuk membandingkan anomali belanja lintas OPD.
 - Gunakan **Mode Revisi Dokumen** untuk menerapkan penyesuaian rekening secara presisi dan menghasilkan versi draf baru yang siap diajukan ke TAPD.`;
}

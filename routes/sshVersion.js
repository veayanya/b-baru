import express from 'express';
import {
 getAllSshDatabases,
 getSshDatabaseById,
 createSshDatabase,
 updateSshDatabaseStatus,
 deleteSshDatabase
} from '../utils/sshStorage.js';

const router = express.Router();

// GET /api/v1/ssh -> list of all SSH database versions (metadata only)
router.get('/', async (req, res) => {
 try {
 const list = await getAllSshDatabases();
 res.json(list);
 } catch (error) {
 console.error('Error fetching SSH databases:', error);
 res.status(500).json({ error: 'Gagal mengambil daftar database SSH' });
 }
});

// GET /api/v1/ssh/:id -> full record including items
router.get('/:id', async (req, res) => {
 try {
 const record = await getSshDatabaseById(req.params.id);
 if (!record) {
 return res.status(404).json({ error: 'Database SSH tidak ditemukan' });
 }
 res.json(record);
 } catch (error) {
 console.error('Error fetching SSH database detail:', error);
 res.status(500).json({ error: 'Gagal mengambil detail database SSH' });
 }
});

// POST /api/v1/ssh -> save a newly extracted SSH database version
router.post('/', async (req, res) => {
 try {
 const { tahun, items } = req.body;
 if (!tahun) {
 return res.status(400).json({ error: 'Tahun anggaran wajib diisi.' });
 }
 if (!Array.isArray(items) || items.length === 0) {
 return res.status(400).json({ error: 'Tidak ada item SSH untuk disimpan.' });
 }

 const saved = await createSshDatabase(req.body);
 res.status(201).json(saved);
 } catch (error) {
 console.error('Error creating SSH database:', error);
 res.status(500).json({ error: 'Gagal menyimpan database SSH' });
 }
});

// PUT /api/v1/ssh/:id -> update status (e.g. active / archived)
router.put('/:id', async (req, res) => {
 try {
 const { status } = req.body;
 if (!status) {
 return res.status(400).json({ error: 'Status wajib diisi.' });
 }
 const updated = await updateSshDatabaseStatus(req.params.id, status);
 if (!updated) {
 return res.status(404).json({ error: 'Database SSH tidak ditemukan.' });
 }
 res.json({ success: true, database: updated });
 } catch (error) {
 console.error('Error updating SSH database:', error);
 res.status(500).json({ error: 'Gagal memperbarui status database SSH' });
 }
});

// DELETE /api/v1/ssh/:id -> delete SSH database
router.delete('/:id', async (req, res) => {
 try {
 const deleted = await deleteSshDatabase(req.params.id);
 if (!deleted) {
 return res.status(404).json({ error: 'Database SSH tidak ditemukan.' });
 }
 res.json({ success: true, message: 'Database SSH berhasil dihapus.' });
 } catch (error) {
 console.error('Error deleting SSH database:', error);
 res.status(500).json({ error: 'Gagal menghapus database SSH' });
 }
});

export default router;

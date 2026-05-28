// src/routes/files.js — Téléchargement fichiers uploadés
const router = require('express').Router();
const fs = require('fs');
const { param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { prisma, getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { filePath } = require('../lib/uploads');

async function canAccessFile(req, file) {
  if (!file || file.isDeleted) return false;
  if (file.userId === req.user.id) return true;

  const companyId = getCompanyId(req);
  if (file.companyId !== companyId) return false;

  const role = req.user.role;
  if (['DRH', 'RH', 'ADMIN', 'MANAGER'].includes(role)) return true;
  if (file.purpose === 'comm_attachment') return true;
  if (file.purpose === 'avatar') return true;

  return false;
}

router.get('/:id',
  authenticate,
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const file = await prisma.uploadedFile.findUnique({ where: { id: req.params.id } });
    if (!(await canAccessFile(req, file))) {
      return res.status(404).json({ error: 'Fichier introuvable.' });
    }

    const p = filePath(file.storedName);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ error: 'Fichier introuvable sur le disque.' });
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`);
    fs.createReadStream(p).pipe(res);
  },
);

module.exports = router;

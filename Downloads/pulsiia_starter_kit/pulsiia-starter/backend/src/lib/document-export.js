// Export ZIP des documents RH (archiver)
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { filePath } = require('./uploads');

function safeZipName(name) {
  return String(name || 'document')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * @param {import('express').Response} res
 * @param {Array<{ originalName: string, storedName: string, collabLabel?: string }>} files
 */
function streamDocumentsZip(res, files, zipBaseName) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const filename = `${safeZipName(zipBaseName || 'documents_rh')}_${new Date().toISOString().slice(0, 10)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

  archive.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Erreur lors de la création du ZIP.' });
    }
  });

  archive.pipe(res);

  const used = new Set();
  files.forEach((file) => {
    const disk = filePath(file.storedName);
    if (!fs.existsSync(disk)) return;
    let entry = safeZipName(file.originalName);
    const prefix = file.collabLabel ? safeZipName(file.collabLabel) + ' - ' : '';
    entry = prefix + entry;
    let finalName = entry;
    let n = 1;
    while (used.has(finalName)) {
      const ext = path.extname(entry);
      const base = path.basename(entry, ext);
      finalName = `${base}_${n}${ext}`;
      n += 1;
    }
    used.add(finalName);
    archive.file(disk, { name: finalName });
  });

  archive.finalize();
}

module.exports = { streamDocumentsZip, safeZipName };

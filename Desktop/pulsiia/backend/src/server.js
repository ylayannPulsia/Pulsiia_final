const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('');
  console.log('  🚀 Pulsiia — Serveur démarré');
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → API : http://localhost:${PORT}/api/health`);
  console.log('');
});

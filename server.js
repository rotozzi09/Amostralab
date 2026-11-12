import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// API endpoints
app.get('/api/access', (_req, res) => {
  res.json({ full: true, logged_in: true });
});

app.get('/api/sounds', (_req, res) => {
  res.json([]);
});

app.get('/api/pad-samples', (_req, res) => {
  res.json({ categories: [], files: [], total: 0 });
});

// Serve static assets with correct MIME types and range support
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
  }
}));

// Fallback to index.html for client-side routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`LabPiano server running on http://${HOST}:${PORT}`);
});

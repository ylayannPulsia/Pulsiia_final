const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..');
const maquettePath = path.join(publicDir, 'maquette.html');
let html = fs.readFileSync(maquettePath, 'utf8');

html = html.replace(
  /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,[^"]+"/,
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg"'
);

html = html.replace(
  /<img src="data:image\/svg\+xml;base64,[^"]+" style="width:32px;height:32px;object-fit:contain;display:block" alt="Pulsiia">/,
  '<img src="/assets/logo.svg" style="width:32px;height:32px;object-fit:contain;display:block" alt="Pulsiia">'
);

fs.writeFileSync(maquettePath, html);
console.log('maquette.html updated');

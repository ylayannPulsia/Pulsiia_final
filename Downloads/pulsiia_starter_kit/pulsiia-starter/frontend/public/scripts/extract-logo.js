const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(publicDir, 'maquette.html'), 'utf8');

const sidebarMatch = html.match(
  /sidebar-logo[\s\S]*?<img src="(data:image\/svg\+xml;base64,[^"]+)"/
);
if (!sidebarMatch) {
  console.error('sidebar logo not found');
  process.exit(1);
}

const logoSvg = Buffer.from(
  sidebarMatch[1].replace('data:image/svg+xml;base64,', ''),
  'base64'
).toString('utf8');

const iconMatch = html.match(
  /<link rel="icon"[^>]+href="(data:image\/svg\+xml;base64,[^"]+)"/
);
const faviconSvg = iconMatch
  ? Buffer.from(
      iconMatch[1].replace('data:image/svg+xml;base64,', ''),
      'base64'
    ).toString('utf8')
  : logoSvg;

fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(publicDir, 'icons'), { recursive: true });

fs.writeFileSync(path.join(publicDir, 'assets', 'logo.svg'), logoSvg);
fs.writeFileSync(path.join(publicDir, 'favicon.svg'), faviconSvg);

console.log('Wrote assets/logo.svg and favicon.svg');

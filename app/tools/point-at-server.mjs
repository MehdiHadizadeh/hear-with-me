// Points the app at the right server for this build, before `cap sync`.
//
//   main and version tags  → https://hearwithme.ir (the live site)
//   anything else          → the staging deployment, which carries the
//                            branch's server changes the live site does not
//
// Override with HWM_SERVER_URL. Used by .github/workflows/app.yml.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = 'https://hearwithme.ir';
const STAGING = 'https://hear-with-me-staging.mehdihadizadeh-k.workers.dev';

const ref = process.env.GITHUB_REF || '';
const live = ref === 'refs/heads/main' || ref.startsWith('refs/tags/v');
const url = process.env.HWM_SERVER_URL || (live ? LIVE : STAGING);

const configPath = path.join(APP, 'capacitor.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.server.url = url;
config.server.allowNavigation = [...new Set([new URL(url).host, 'hearwithme.ir', '*.hearwithme.ir'])];
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

// The bundled fallback pages link back to the server too.
for (const page of ['index.html', 'offline.html']) {
  const file = path.join(APP, 'www', page);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(`${LIVE}/`).join(`${url}/`));
}
console.log(`app opens ${url}`);

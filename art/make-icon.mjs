// Renders art/icon.svg to .claude-plugin/icon.png (1024 px, the plugin directory's listing icon), the way Model
// Organizer's tools/make-icons.mjs does it. Needs sharp, which this repository doesn't install: point SHARP at an
// installed copy, e.g. `SHARP=<a project>/node_modules/sharp node art/make-icon.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sharp = createRequire(import.meta.url)(process.env.SHARP ?? 'sharp');
const svg = fs.readFileSync(path.join(root, 'art', 'icon.svg'));
const out = path.join(root, '.claude-plugin', 'icon.png');
// the SVG is 256 units wide: 400 dpi draws it past 1024 px before scaling down (crisp edges)
await sharp(svg, { density: 400 }).resize(1024, 1024).png().toFile(out);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);

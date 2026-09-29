// Builds partyline.ico (the desktop shortcut's icon) from the SVG below.
// Each size is rendered by headless Edge, then packed into one .ico.
// Usage: npx tsx scripts/make-icon.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// The board's mark: a coral tile with a phone-cord squiggle. Small sizes get a thicker cord.
const die = (small: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a6c"/><stop offset="1" stop-color="#e8663a"/></linearGradient></defs>
<rect x="${small ? 0 : 1}" y="${small ? 0 : 1}" width="${small ? 32 : 30}" height="${small ? 32 : 30}" rx="${small ? 6 : 8}" fill="url(#g)"/>
<path d="M7 16c3-9 6 9 9 0s6 9 9 0" fill="none" stroke="#fff" stroke-width="${small ? 4 : 3}" stroke-linecap="round"/>
</svg>`;

const dir = mkdtempSync(join(tmpdir(), "partyline-icon-"));
const pngs: Buffer[] = [];
try {
  for (const size of SIZES) {
    const page = join(dir, `${size}.html`);
    const shot = join(dir, `${size}.png`);
    writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}div{width:${size}px;height:${size}px}</style><div>${die(size < 32)}</div>`);
    execFileSync(EDGE, ["--headless", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
      `--window-size=${size},${size}`, `--screenshot=${shot}`, pathToFileURL(page).href], { stdio: "ignore" });
    const png = readFileSync(shot);
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w !== size || h !== size) throw new Error(`Edge rendered ${w}x${h} for ${size}px`);
    pngs.push(png);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ICO: a 6-byte header, a 16-byte entry per image, then the PNGs themselves.
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map((png, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(SIZES[i] % 256, 0); // 256 is written as 0
  e.writeUInt8(SIZES[i] % 256, 1);
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
});
const out = resolve("partyline.ico");
writeFileSync(out, Buffer.concat([header, ...entries, ...pngs]));
console.log(`wrote ${out}`);

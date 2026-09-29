// Zips skill/partyline/SKILL.md into skill/partyline.zip, ready to upload to claude.ai.
// Usage: npm run skill   (works on any OS; no zip tool needed)
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

const name = "partyline/SKILL.md";
const data = readFileSync(`skill/${name}`);
const packed = deflateRawSync(data);
const path = Buffer.from(name);
const crc = crc32(data);

// One deflated file: local header, data, central directory entry, end record.
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4); // version needed
local.writeUInt16LE(8, 8); // deflate
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(packed.length, 18);
local.writeUInt32LE(data.length, 22);
local.writeUInt16LE(path.length, 26);

const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4); // made by
central.writeUInt16LE(20, 6); // version needed
central.writeUInt16LE(8, 10);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(packed.length, 20);
central.writeUInt32LE(data.length, 24);
central.writeUInt16LE(path.length, 28);

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length + path.length, 12);
end.writeUInt32LE(local.length + path.length + packed.length, 16);

writeFileSync("skill/partyline.zip", Buffer.concat([local, path, packed, central, path, end]));
console.log("Built skill/partyline.zip. Upload it in claude.ai under Settings → Capabilities → Skills.");

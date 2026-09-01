#!/usr/bin/env node
// cave/schematics/convert-v3-to-v2.mjs — Sponge Schematic v3 -> v2 downgrade.
//
// WHY THIS EXISTS (house-build project, 2026-09-01):
// The pinned Baritone jar this fleet runs (baritone-standalone-fabric-1.17.0,
// tag v1.17.0 == branch 1.21.11, field-checked against the REAL source —
// see cave/BARITONE.md's house-build research note) only understands Sponge
// Schematic format Version 1 or 2:
//
//   SpongeSchematic.java: `switch (nbt.getInt("Version")) { case 1: case 2:
//   ... default: throw new UnsupportedOperationException("Unsupported
//   Version of a Sponge Schematic"); }`
//
// Any modern WorldEdit/schematic tool exports Version 3 by default. v3 also
// RESTRUCTURES the file: v1/v2 keep Width/Height/Length/Palette/BlockData at
// the NBT root; v3 nests everything one level down under a root "Schematic"
// compound, and additionally moves Palette/BlockData into a nested "Blocks"
// compound (renaming BlockData -> "Data" there). Baritone's parser reads
// Version/Width/Height/Length/Palette/BlockData at the ROOT ONLY — it has no
// v3 support at all, so a v3 .schem silently looks fine to Baritone right up
// until `#build` throws. Ground-truthed against 3 real files dropped in this
// dir: ALL THREE were Version 3 and would have failed this exact way.
//
// This script hoists the nested v3 fields back to v2's flat root shape and
// stamps Version=2. It is a pure byte-preserving move for Palette/BlockData
// (StaticSchematic — Baritone's block-states-only schematic base class —
// never reads Offset/BlockEntities/Metadata/DataVersion, so those are kept
// best-effort for other tools but are not load-bearing for baritone).
//
// Usage:
//   node cave/schematics/convert-v3-to-v2.mjs <name>.schem [more.schem ...]
//
// Writes <name>.schem in place (the ORIGINAL v3 bytes are preserved next to
// it as <name>.v3-original.schem, never deleted) so `/build {schematic:
// "<name>"}` on the wrapper resolves the canonical filename straight to a
// file baritone can actually load. Round-trip-verifies every write (re-parse
// -> Version==2, palette count unchanged, BlockData byte length unchanged)
// before declaring success; already-v2/v1 files are left untouched.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';

async function convertOne(file) {
  const buf = fs.readFileSync(file);
  const { parsed } = await nbt.parse(buf);
  const root = parsed.value;

  if (root.Version) {
    console.log(`${file}: already root-level Version=${root.Version.value} (v1/v2 shape) — no conversion needed, left as-is.`);
    return;
  }
  const inner = root.Schematic?.value;
  const blocks = inner?.Blocks?.value;
  if (!inner || !blocks || !blocks.Palette || !blocks.Data) {
    throw new Error(`${file}: not the v3 shape this script knows how to fix (no Schematic.Blocks.Palette/Data) — do not guess, fix by hand or extend this script after checking the real bytes.`);
  }

  const rootVal = {
    Version: { type: 'int', value: 2 },
    Width: inner.Width,
    Height: inner.Height,
    Length: inner.Length,
    Palette: blocks.Palette,
    BlockData: { type: 'byteArray', value: blocks.Data.value },
  };
  if (inner.DataVersion) rootVal.DataVersion = inner.DataVersion;
  if (inner.Offset) rootVal.Offset = inner.Offset;
  if (inner.Metadata) rootVal.Metadata = inner.Metadata;
  if (blocks.BlockEntities) rootVal.BlockEntities = blocks.BlockEntities;

  const gz = zlib.gzipSync(nbt.writeUncompressed({ type: 'compound', name: '', value: rootVal }, 'big'));

  // Round-trip verify before touching anything on disk.
  const reread = (await nbt.parse(gz)).parsed.value;
  const okVersion = reread.Version?.value === 2;
  const okPalette = Object.keys(reread.Palette.value).length === Object.keys(blocks.Palette.value).length;
  const okData = reread.BlockData.value.length === blocks.Data.value.length;
  if (!okVersion || !okPalette || !okData) {
    throw new Error(`${file}: round-trip verify FAILED (version=${okVersion} palette=${okPalette} data=${okData}) — refusing to write, original untouched.`);
  }

  const backup = file.replace(/\.schem$/i, '') + '.v3-original.schem';
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, gz);
  console.log(`${file}: converted v3 -> v2 in place (original preserved at ${path.basename(backup)}). Palette=${okPalette ? 'match' : '?'} BlockData=${okData ? 'match' : '?'}`);
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node cave/schematics/convert-v3-to-v2.mjs <name>.schem [more.schem ...]');
    process.exit(1);
  }
  for (const f of files) {
    await convertOne(f);
  }
}

main().catch((e) => {
  console.error('convert-v3-to-v2 failed:', e.message);
  process.exit(1);
});

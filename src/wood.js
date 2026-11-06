import { DataTexture, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from "three";

// The perch ("log") is a long pentagonal pole. Its 3DS UVs wrap u around the
// circumference and run v along the length, so the grain streaks follow v.
const LIGHT = [176, 128, 80];
const DARK = [104, 66, 36];

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Smooth 1D value noise that repeats every `period` cells, so the texture
// tiles without a seam where u wraps around the pole.
function noise(x, period) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(((i % period) + period) % period);
  const b = hash((((i + 1) % period) + period) % period);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

export function woodTexture(width = 256, height = 1024) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = y / height;
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      // Slow waviness along the length bends the grain lines.
      const warp = 0.6 * noise(v * 6 + 3, 6) + 0.25 * noise(v * 23 + u * 4, 23);
      const rings = noise(u * 24 + warp * 3, 24) * 0.7 + noise(u * 96 + warp * 6, 96) * 0.3;
      const streak = Math.pow(Math.abs(Math.sin((u * 18 + warp) * Math.PI)), 6);
      const fleck = noise(u * 160 + 7, 160) * noise(v * 400 + 11, 400);
      const t = Math.min(1, Math.max(0, 0.15 + rings * 0.55 + streak * 0.35 - fleck * 0.2));
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) data[i + c] = Math.round(LIGHT[c] + (DARK[c] - LIGHT[c]) * t);
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, width, height);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AnimationMixer, Quaternion, Vector3 } from "three";
import { load3DS } from "../src/load3ds.js";

const file = new URL("../public/models/test_lizard_01.3ds", import.meta.url);
const bytes = fs.readFileSync(file);

function load() {
  return load3DS(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

test("uses the 3DS biped clip and the skin mesh", () => {
  const loaded = load();
  assert.equal(loaded.meta.sourceFile, "test_lizard_01.3DS");
  assert.equal(loaded.meta.animationName, "MAXSCENE");
  assert.equal(loaded.meta.skinVertices, 439);
  assert.ok(loaded.meta.deformBones > 40);
  assert.equal(loaded.clip.name, "MAXSCENE");
  assert.ok(loaded.clip.tracks.some((track) => track.name === "Bip01.position"));
  assert.ok(loaded.clip.duration >= 200 / 30 - 0.01);
});

test("bind pose puts the head joint on the exported head mesh", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const head = loaded.object.getObjectByName("Bip01 Head");
  const position = new Vector3();
  head.getWorldPosition(position);
  assert.ok(Math.abs(position.x - 26.2) < 1.5, `x ${position.x}`);
  assert.ok(Math.abs(position.y + 117) < 2, `y ${position.y}`);
  assert.ok(Math.abs(position.z - 189) < 2, `z ${position.z}`);
});

test("skin vertices round-trip through the node transform and pivot", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const source = loaded.skin.userData.sourcePositions;
  const pivot = loaded.skin.userData.pivot;
  const position = loaded.skin.geometry.attributes.position;
  const point = new Vector3();
  let worst = 0;
  for (let i = 0; i < position.count; i += 40) {
    // Local positions are stored relative to the 3DS pivot. Adding it back
    // recovers the exported vertex before the node matrix is applied.
    point.fromBufferAttribute(position, i);
    point.x += pivot[0];
    point.y += pivot[1];
    point.z += pivot[2];
    point.applyMatrix4(loaded.skin.matrixWorld);
    const dx = point.x - source[i * 3];
    const dy = point.y - source[i * 3 + 1];
    const dz = point.z - source[i * 3 + 2];
    worst = Math.max(worst, Math.hypot(dx, dy, dz));
  }
  assert.ok(worst < 0.5, `worst error ${worst}`);
  assert.ok(Math.hypot(pivot[0], pivot[1], pivot[2]) > 10, "skin pivot should offset the mesh onto the biped");
});

test("every skin vertex has normalized weights", () => {
  const loaded = load();
  const weights = loaded.skin.geometry.attributes.skinWeight;
  for (let i = 0; i < weights.count; i += 1) {
    const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
    assert.ok(Math.abs(sum - 1) < 1e-3, `vertex ${i} sums to ${sum}`);
  }
});

test("bind-pose skinning does not move the surface", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const position = loaded.skin.geometry.attributes.position;
  const local = new Vector3();
  const skinned = new Vector3();
  let worst = 0;
  for (let i = 0; i < position.count; i += 20) {
    local.fromBufferAttribute(position, i);
    loaded.skin.applyBoneTransform(i, skinned.copy(local));
    worst = Math.max(worst, local.distanceTo(skinned));
  }
  assert.ok(worst < 0.5, `worst skinning error ${worst}`);
});

test("the skin pivot pulls the extremities onto the biped", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const position = loaded.skin.geometry.attributes.position;
  const point = new Vector3();
  const bonePoint = new Vector3();
  const names = ["Bip01 Tai4", "Bip01 L F4", "Bip01 R F4", "Bip01 L T4", "Bip01 R T4"];
  for (const name of names) {
    loaded.object.getObjectByName(name).getWorldPosition(bonePoint);
    let nearest = Infinity;
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i);
      loaded.skin.localToWorld(point);
      nearest = Math.min(nearest, point.distanceTo(bonePoint));
    }
    assert.ok(nearest < 8, `${name} is ${nearest.toFixed(1)} from the skin`);
  }
});

test("the root joint keeps its perch orientation", () => {
  const loaded = load();
  const rootBone = loaded.object.getObjectByName("Bip01");
  const rest = rootBone.quaternion.clone();
  const mixer = new AnimationMixer(loaded.object);
  const action = mixer.clipAction(loaded.clip);
  action.play();
  for (const frame of [30, 60, 94]) {
    mixer.setTime(frame / 30);
    const turn = new Quaternion().copy(rest).invert().multiply(rootBone.quaternion);
    const angle = (2 * Math.acos(Math.min(1, Math.abs(turn.w))) * 180) / Math.PI;
    assert.ok(angle < 1, `frame ${frame} root turned ${angle.toFixed(1)}°`);
  }
});

test("the clip moves the head", () => {
  const loaded = load();
  const head = loaded.object.getObjectByName("Bip01 Head");
  const before = new Vector3();
  const after = new Vector3();
  head.getWorldPosition(before);
  const mixer = new AnimationMixer(loaded.object);
  const action = mixer.clipAction(loaded.clip);
  action.play();
  mixer.update(35 / 30);
  loaded.object.updateMatrixWorld(true);
  head.getWorldPosition(after);
  assert.ok(before.distanceTo(after) > 20, `moved ${before.distanceTo(after)}`);
  mixer.setTime(0);
  loaded.object.updateMatrixWorld(true);
});

test("the perch pole is textured in a wood colour", () => {
  const loaded = load();
  const log = loaded.object.getObjectByName("log");
  const map = log.material.map;
  assert.ok(map, "the log material has a texture map");
  assert.ok(log.geometry.attributes.uv, "the log mesh has UVs for the map");
  const { data } = map.image;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  r /= pixels;
  g /= pixels;
  b /= pixels;
  // Wood is a warm brown: red over green over blue, neither near black nor white.
  assert.ok(r > g && g > b, `average colour ${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}`);
  assert.ok(r > 90 && r < 220, `red ${r.toFixed(0)}`);
});

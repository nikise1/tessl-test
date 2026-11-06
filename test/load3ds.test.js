import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AnimationMixer, Vector3 } from "three";
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

test("skin vertices round-trip through the node transform", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const source = loaded.skin.userData.sourcePositions;
  const position = loaded.skin.geometry.attributes.position;
  const point = new Vector3();
  let worst = 0;
  for (let i = 0; i < position.count; i += 40) {
    point.fromBufferAttribute(position, i).applyMatrix4(loaded.skin.matrixWorld);
    const dx = point.x - source[i * 3];
    const dy = point.y - source[i * 3 + 1];
    const dz = point.z - source[i * 3 + 2];
    worst = Math.max(worst, Math.hypot(dx, dy, dz));
  }
  assert.ok(worst < 0.5, `worst error ${worst}`);
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

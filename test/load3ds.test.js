import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AnimationMixer, Quaternion, Vector3 } from "three";
import { FPS, load3DS } from "../src/load3ds.js";

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
  assert.ok(loaded.clip.tracks.some((track) => track.name === "Bip01 Head.quaternion"));
  assert.ok(loaded.clip.duration >= 200 / FPS - 0.01);
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
    mixer.setTime(frame / FPS);
    const turn = new Quaternion().copy(rest).invert().multiply(rootBone.quaternion);
    const angle = (2 * Math.acos(Math.min(1, Math.abs(turn.w))) * 180) / Math.PI;
    assert.ok(angle < 1, `frame ${frame} root turned ${angle.toFixed(1)}°`);
  }
});

test("the root joint keeps its centre through the clip", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const rootBone = loaded.object.getObjectByName("Bip01");
  const rest = new Vector3();
  const now = new Vector3();
  rootBone.getWorldPosition(rest);
  const mixer = new AnimationMixer(loaded.object);
  mixer.clipAction(loaded.clip).play();
  // The source keys slide the root out and snap it back at frames 12, 24, 37,
  // 49 and 62; held on its first key it stays put on each side of those.
  for (const frame of [11, 12, 23, 24, 36, 37, 61, 62, 94]) {
    mixer.setTime(frame / FPS);
    loaded.object.updateMatrixWorld(true);
    rootBone.getWorldPosition(now);
    assert.ok(now.distanceTo(rest) < 1e-3, `frame ${frame} root moved ${now.distanceTo(rest).toFixed(1)}`);
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
  mixer.update(35 / FPS);
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

function tongueTip(loaded) {
  // The farthest skinned vertex along the tongue is the end of the club.
  const { mesh } = loaded.tongue;
  const position = mesh.geometry.attributes.position;
  const point = new Vector3();
  const root = new Vector3();
  loaded.tongue.bones[0].getWorldPosition(root);
  let tip = null;
  for (let i = 0; i < position.count; i += 1) {
    mesh.applyBoneTransform(i, point.fromBufferAttribute(position, i));
    mesh.localToWorld(point);
    if (!tip || point.distanceTo(root) > tip.distanceTo(root)) tip = point.clone();
  }
  return tip;
}

test("the tongue sits in the mouth on its own bones under the lower jaw", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const root = loaded.object.getObjectByName("Tongue");
  const tip = loaded.object.getObjectByName("Tongue Tip");
  assert.ok(root?.isBone && tip?.isBone, "tongue bones exist");
  assert.equal(root.parent.name, "Bip01 Bott");
  // The tongue is a chain of bones from the root to the tip, not just two.
  const { bones } = loaded.tongue;
  assert.ok(bones.length > 2, `${bones.length} tongue bones`);
  assert.equal(bones[0], root);
  assert.equal(bones.at(-1), tip);
  bones.slice(1).forEach((bone, i) => assert.equal(bone.parent, bones[i], bone.name));
  assert.deepEqual(loaded.tongue.mesh.skeleton.bones, bones);
  const weights = loaded.tongue.mesh.geometry.attributes.skinWeight;
  for (let i = 0; i < weights.count; i += 1) {
    assert.ok(Math.abs(weights.getX(i) + weights.getY(i) - 1) < 1e-6, `vertex ${i}`);
  }
  // At rest the whole tongue stays inside the head, near the jaw.
  const jaw = new Vector3();
  loaded.object.getObjectByName("Bip01 Bott").getWorldPosition(jaw);
  const distance = tongueTip(loaded).distanceTo(jaw);
  assert.ok(distance < 70, `tongue tip is ${distance.toFixed(1)} from the jaw`);
});

test("the tongue grows out of the mouth and shrinks back", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  const rest = tongueTip(loaded);
  const rootBefore = new Vector3();
  const rootAfter = new Vector3();
  loaded.tongue.bones[0].getWorldPosition(rootBefore);

  loaded.tongue.setExtension(1);
  const out = tongueTip(loaded);
  loaded.tongue.bones[0].getWorldPosition(rootAfter);
  assert.equal(loaded.tongue.extension, 1);
  assert.ok(Math.abs(out.distanceTo(rest) - loaded.tongue.reach) < 1, `moved ${out.distanceTo(rest)}`);
  assert.ok(rootAfter.distanceTo(rootBefore) < 1e-6, "the root stays in the mouth");
  const length = out.distanceTo(rootAfter);
  assert.ok(Math.abs(length - 524) < 1, `full tongue is ${length.toFixed(1)} long`);

  loaded.tongue.setExtension(0.5);
  const half = tongueTip(loaded);
  assert.ok(Math.abs(half.distanceTo(rest) - loaded.tongue.reach / 2) < 1, `half moved ${half.distanceTo(rest)}`);

  loaded.tongue.setExtension(0);
  assert.ok(tongueTip(loaded).distanceTo(rest) < 1e-3, "the tongue returns to rest");
  loaded.tongue.setExtension(5);
  assert.equal(loaded.tongue.extension, 1, "extension clamps to 1");
});

test("the tongue ripples along its bones and straightens again", () => {
  const loaded = load();
  loaded.object.updateMatrixWorld(true);
  loaded.tongue.setExtension(1);
  const straight = tongueTip(loaded);
  const root = new Vector3();
  loaded.tongue.bones[0].getWorldPosition(root);
  const length = straight.distanceTo(root);

  loaded.tongue.setWave(1, Math.PI / 2);
  const bent = tongueTip(loaded);
  const offset = bent.distanceTo(straight);
  assert.ok(offset > 10, `the tip moved ${offset.toFixed(1)} when the tongue bent`);
  // A ripple bends the tongue, it does not stretch it.
  assert.ok(bent.distanceTo(root) <= length + 1, `bent tongue is ${bent.distanceTo(root).toFixed(1)} long`);
  // The joints near the root bend least, so the base stays in the mouth.
  const [first, second] = loaded.tongue.bones.slice(1);
  assert.ok(Math.abs(first.rotation.z) < Math.abs(loaded.tongue.bones.at(-1).rotation.z) + 1e-9);
  assert.ok(Math.abs(first.rotation.z) > 0 || Math.abs(second.rotation.z) > 0, "the ripple reaches the base");

  loaded.tongue.setWave(0);
  assert.equal(loaded.tongue.wave, 0);
  assert.ok(tongueTip(loaded).distanceTo(straight) < 1e-3, "the tongue is straight again");
});

test("the tongue follows the jaw through the clip", () => {
  const loaded = load();
  const mixer = new AnimationMixer(loaded.object);
  mixer.clipAction(loaded.clip).play();
  mixer.setTime(35 / FPS);
  loaded.object.updateMatrixWorld(true);
  const jaw = new Vector3();
  const root = new Vector3();
  loaded.object.getObjectByName("Bip01 Bott").getWorldPosition(jaw);
  loaded.tongue.bones[0].getWorldPosition(root);
  assert.ok(root.distanceTo(jaw) < 25, `tongue root is ${root.distanceTo(jaw).toFixed(1)} from the jaw`);
});

function jointPositions(loaded) {
  loaded.object.updateMatrixWorld(true);
  return loaded.bones.map((bone) => bone.getWorldPosition(new Vector3()));
}

function farthest(a, b) {
  return Math.max(...a.map((point, index) => point.distanceTo(b[index])));
}

test("the clip splits into six separate actions at 25 fps", () => {
  const loaded = load();
  assert.equal(FPS, 25);
  assert.deepEqual(
    loaded.actions.map(({ name, start, end }) => [name, start, end]),
    [
      ["Action 1", 0, 11],
      ["Action 2", 12, 23],
      ["Action 3", 24, 36],
      ["Action 4", 37, 48],
      ["Action 5", 49, 61],
      ["Eat", 62, 93],
    ],
  );
  loaded.actions.forEach(({ clip, start, end, lead }) => {
    assert.ok(Math.abs(clip.duration - (2 * lead + end - start) / FPS) < 1e-9, clip.name);
  });
});

test("each action starts and ends at rest", () => {
  const loaded = load();
  const rest = jointPositions(loaded);
  const mixer = new AnimationMixer(loaded.object);
  loaded.actions.forEach(({ clip }) => {
    const action = mixer.clipAction(clip);
    action.play();
    for (const time of [0, clip.duration]) {
      action.time = time;
      mixer.update(0);
      const off = farthest(jointPositions(loaded), rest);
      assert.ok(off < 1e-3, `${clip.name} at ${time.toFixed(2)}s is ${off.toFixed(1)} off rest`);
    }
    action.stop();
  });
});

test("an action plays its own frames of the source clip", () => {
  const loaded = load();
  const mixer = new AnimationMixer(loaded.object);
  const whole = mixer.clipAction(loaded.clip);
  const { clip, start, end, lead } = loaded.actions[3];
  const part = mixer.clipAction(clip);
  for (let frame = start; frame <= end; frame += 1) {
    whole.play();
    mixer.setTime(frame / FPS);
    const expected = jointPositions(loaded);
    whole.stop();
    part.play();
    part.time = (lead + frame - start) / FPS;
    mixer.update(0);
    const off = farthest(jointPositions(loaded), expected);
    part.stop();
    assert.ok(off < 1e-3, `frame ${frame} is ${off.toFixed(2)} off the source`);
  }
});

test("no action snaps between frames the way the joined clip does", () => {
  const loaded = load();
  const mixer = new AnimationMixer(loaded.object);
  // The joined clip snaps the tail about 300 units at frame 37.
  const whole = mixer.clipAction(loaded.clip);
  whole.play();
  mixer.setTime(36 / FPS);
  const before = jointPositions(loaded);
  mixer.setTime(37 / FPS);
  assert.ok(farthest(jointPositions(loaded), before) > 250, "the joined clip snaps at frame 37");
  whole.stop();
  loaded.actions.forEach(({ clip }) => {
    const action = mixer.clipAction(clip);
    action.play();
    let previous = jointPositions(loaded);
    for (let frame = 1; frame <= Math.round(clip.duration * FPS); frame += 1) {
      action.time = frame / FPS;
      mixer.update(0);
      const now = jointPositions(loaded);
      const step = farthest(now, previous);
      assert.ok(step < 100, `${clip.name} jumps ${step.toFixed(0)} at frame ${frame}`);
      previous = now;
    }
    action.stop();
  });
});

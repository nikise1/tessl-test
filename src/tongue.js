import {
  Bone,
  BufferAttribute,
  LatheGeometry,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Vector2,
} from "three";

// The 3DS file has no tongue, so this one is built in code. It hangs off the
// lower jaw (Bip01 Bott) and follows the jaw through the clip. The jaw's +x
// runs from the mouth corner to the chin; the upper jaw sits at -y.
const ROOT = [12, -17, 0];
// Aim straight out along the snout, just under the upper jaw, so the tongue
// leaves the mouth in line with the head rather than drooping toward the chin.
const PITCH = (-16 * Math.PI) / 180;
// Shaft from the root to the club, then the sticky club at the tip.
const SHAFT = 32;
const CLUB = 10;
// The shaft is a chain of this many segments, each on its own bone, so it can
// bend along its length like a lizard's tongue instead of sliding as one rod.
const SEGMENTS = 8;
const SEGMENT = SHAFT / SEGMENTS;
// Largest bend, at the tip joint, for a wave of 1. Joints nearer the root bend
// less, so the base stays in the mouth while the far end whips.
const BEND = (16 * Math.PI) / 180;
// How far along the chain, in radians per joint, one ripple of the wave runs.
const RIPPLE = 0.9;
// At full extension the club is this far past its rest position, so the whole
// tongue measures SHAFT + CLUB + REACH = 524 from root to tip.
const REACH = 482;

function profile() {
  const points = [];
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const x = (i / steps) * SHAFT;
    points.push(new Vector2(4.2 - (x / SHAFT) * 1.4, x));
  }
  const clubSteps = 10;
  for (let i = 1; i <= clubSteps; i += 1) {
    const t = i / clubSteps;
    // The club swells past the shaft and closes to a point at the tip.
    points.push(new Vector2(Math.max(2.8 * (1 - t), 5.5 * Math.sin(Math.PI * t)), SHAFT + t * CLUB));
  }
  return points;
}

function tongueGeometry() {
  const geometry = new LatheGeometry(profile(), 14);
  // Lathe runs along +y. Turn it so the tongue runs along the root bone's +x.
  geometry.rotateZ(-Math.PI / 2);
  const position = geometry.attributes.position;
  const skinIndex = new Uint16Array(position.count * 4);
  const skinWeight = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i += 1) {
    // Each shaft vertex blends the two bones at the ends of its segment, so
    // spreading the joints stretches the shaft evenly and bending them curves
    // it smoothly. The club rides the tip bone and keeps its shape.
    const along = Math.min(SEGMENTS, Math.max(0, position.getX(i) / SEGMENT));
    const segment = Math.min(SEGMENTS - 1, Math.floor(along));
    const blend = along - segment;
    skinIndex[i * 4] = segment;
    skinIndex[i * 4 + 1] = segment + 1;
    skinWeight[i * 4] = 1 - blend;
    skinWeight[i * 4 + 1] = blend;
  }
  geometry.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));
  return geometry;
}

export function addTongue(jaw) {
  const root = new Bone();
  root.name = "Tongue";
  root.position.set(ROOT[0], ROOT[1], ROOT[2]);
  root.rotation.z = PITCH;
  const bones = [root];
  for (let i = 1; i <= SEGMENTS; i += 1) {
    const joint = new Bone();
    joint.name = i === SEGMENTS ? "Tongue Tip" : `Tongue ${i}`;
    joint.position.set(SEGMENT, 0, 0);
    bones[i - 1].add(joint);
    bones.push(joint);
  }
  const joints = bones.slice(1);
  bones.forEach((bone) => {
    bone.userData.deform = true;
  });

  const mesh = new SkinnedMesh(
    tongueGeometry(),
    new MeshStandardMaterial({ color: 0xd65c6e, roughness: 0.42, metalness: 0 }),
  );
  mesh.name = "tongue";
  mesh.position.copy(root.position);
  mesh.quaternion.copy(root.quaternion);
  mesh.frustumCulled = false;
  jaw.add(root, mesh);
  jaw.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));

  let extension = 0;
  let wave = 0;
  let phase = 0;
  return {
    mesh,
    bones,
    reach: REACH,
    get extension() {
      return extension;
    },
    get wave() {
      return wave;
    },
    // 0 keeps the tongue in the mouth, 1 shoots the club out by REACH. Every
    // segment grows by the same share, so the joints stay evenly spaced.
    setExtension(value) {
      extension = Math.min(1, Math.max(0, Number(value) || 0));
      joints.forEach((joint) => {
        joint.position.x = SEGMENT + (extension * REACH) / SEGMENTS;
      });
      root.updateMatrixWorld(true);
    },
    // Ripples the tongue up and down along its joints. 0 holds it straight;
    // 1 bends the tip joint by BEND. Moving the phase sends the ripple along it.
    setWave(value, at = phase) {
      wave = Math.min(1, Math.max(-1, Number(value) || 0));
      phase = Number(at) || 0;
      joints.forEach((joint, i) => {
        const share = (i + 1) / SEGMENTS;
        joint.rotation.z = wave * BEND * share * Math.sin(phase - i * RIPPLE);
      });
      root.updateMatrixWorld(true);
    },
  };
}

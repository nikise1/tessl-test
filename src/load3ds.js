import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from "three";

// three.js r187 TDSLoader reads meshes only. This file also reads the
// keyframe chunk (0xB000) so the Character Studio biped can play.
const MAIN = 0x4d4d;
const EDIT = 0x3d3d;
const OBJ = 0x4000;
const TRIMESH = 0x4100;
const VERTS = 0x4110;
const FACES = 0x4120;
const UV = 0x4140;
const MTX = 0x4160;
const MASTER = 0x0100;
const KEYF = 0xb000;
const NODE = 0xb002;
const KFHDR = 0xb00a;
const KFSEG = 0xb008;
const HDR = 0xb010;
const INST = 0xb011;
const PIVOT = 0xb013;
const POS = 0xb020;
const ROT = 0xb021;
const SCL = 0xb022;

const FPS = 30;

const decoder = new TextDecoder("latin1");

function readString(view, offset, end) {
  let cursor = offset;
  while (cursor < end && view.getUint8(cursor) !== 0) cursor += 1;
  const text = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, cursor - offset));
  return { text, next: Math.min(end, cursor + 1) };
}

function readKeys(view, offset, end, strideFloats) {
  const count = view.getUint32(offset + 10, true);
  let cursor = offset + 14;
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    const frame = view.getUint32(cursor, true);
    const flags = view.getUint16(cursor + 4, true);
    cursor += 6;
    for (const bit of [0x1, 0x2, 0x4, 0x8, 0x10]) {
      if (flags & bit) cursor += 4;
    }
    const values = [];
    for (let k = 0; k < strideFloats; k += 1) {
      values.push(view.getFloat32(cursor, true));
      cursor += 4;
    }
    keys.push({ frame, values });
    if (cursor > end) break;
  }
  return keys;
}

function matrixFrom3DS(values) {
  const matrix = new Matrix4();
  matrix.set(
    values[0], values[3], values[6], values[9],
    values[1], values[4], values[7], values[10],
    values[2], values[5], values[8], values[11],
    0, 0, 0, 1,
  );
  return matrix;
}

// 3DS rotation keys are relative axis-angles. Assimp negates w, then
// accumulates q_abs = q_abs * q_delta. That orientation matches this file:
// joint positions land on the exported bone meshes.
function absoluteQuaternions(rotKeys) {
  const absolute = [];
  const acc = new Quaternion();
  rotKeys.forEach((key, index) => {
    const [angle, ax, ay, az] = key.values;
    const length = Math.hypot(ax, ay, az) || 1;
    const half = Math.sin(angle / 2);
    const delta = new Quaternion(
      (ax / length) * half,
      (ay / length) * half,
      (az / length) * half,
      -Math.cos(angle / 2),
    ).normalize();
    if (index === 0) acc.copy(delta);
    else acc.multiply(delta).normalize();
    const q = acc.clone();
    if (absolute.length > 0 && absolute[absolute.length - 1].dot(q) < 0) {
      q.set(-q.x, -q.y, -q.z, -q.w);
    }
    absolute.push(q);
  });
  return absolute;
}

function parse(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const meshes = new Map();
  const nodes = [];
  let masterScale = 1;
  let animationName = "MAXSCENE";
  let frameCount = 200;
  let segment = [0, 200];

  function walk(start, end, visit) {
    let offset = start;
    while (offset + 6 <= end) {
      const id = view.getUint16(offset, true);
      const length = view.getUint32(offset + 2, true);
      if (length < 6 || offset + length > end) return;
      visit(id, offset + 6, offset + length);
      offset += length;
    }
  }

  function onMain(id, start, end) {
    if (id === EDIT) walk(start, end, onEdit);
    else if (id === KEYF) walk(start, end, onKeyf);
  }

  function onEdit(id, start, end) {
    if (id === MASTER && end >= start + 4) {
      masterScale = view.getFloat32(start, true);
    } else if (id === OBJ) {
      const { text, next } = readString(view, start, end);
      const mesh = { name: text, vertices: null, uvs: null, indices: null, matrix: new Matrix4() };
      walk(next, end, (childId, childStart, childEnd) => {
        if (childId === TRIMESH) walk(childStart, childEnd, (partId, partStart, partEnd) => onTri(mesh, partId, partStart, partEnd));
      });
      meshes.set(text, mesh);
    }
  }

  function onTri(mesh, id, start, end) {
    if (id === VERTS) {
      const count = view.getUint16(start, true);
      const vertices = new Float32Array(count * 3);
      let cursor = start + 2;
      for (let i = 0; i < vertices.length; i += 1) {
        vertices[i] = view.getFloat32(cursor, true);
        cursor += 4;
      }
      mesh.vertices = vertices;
    } else if (id === UV) {
      const count = view.getUint16(start, true);
      const uvs = new Float32Array(count * 2);
      let cursor = start + 2;
      for (let i = 0; i < uvs.length; i += 1) {
        uvs[i] = view.getFloat32(cursor, true);
        cursor += 4;
      }
      mesh.uvs = uvs;
    } else if (id === FACES) {
      const count = view.getUint16(start, true);
      const indices = new Uint32Array(count * 3);
      let cursor = start + 2;
      for (let i = 0; i < count; i += 1) {
        indices[i * 3] = view.getUint16(cursor, true);
        indices[i * 3 + 1] = view.getUint16(cursor + 2, true);
        indices[i * 3 + 2] = view.getUint16(cursor + 4, true);
        cursor += 8;
      }
      mesh.indices = indices;
    } else if (id === MTX) {
      const values = [];
      for (let i = 0; i < 12; i += 1) values.push(view.getFloat32(start + i * 4, true));
      mesh.matrix = matrixFrom3DS(values);
    }
  }

  function onKeyf(id, start, end) {
    if (id === KFHDR) {
      const { text, next } = readString(view, start + 2, end);
      animationName = text || animationName;
      if (next + 4 <= end) frameCount = view.getUint32(next, true);
    } else if (id === KFSEG && end >= start + 8) {
      segment = [view.getUint32(start, true), view.getUint32(start + 4, true)];
    } else if (id === NODE) {
      const node = {
        name: "",
        instance: "",
        hier: 0,
        pivot: [0, 0, 0],
        pos: [],
        rot: [],
        scl: [],
      };
      walk(start, end, (childId, childStart, childEnd) => {
        if (childId === HDR) {
          const { text, next } = readString(view, childStart, childEnd);
          node.name = text;
          if (next + 6 <= childEnd) node.hier = view.getUint16(next + 4, true);
        } else if (childId === INST) {
          node.instance = readString(view, childStart, childEnd).text;
        } else if (childId === PIVOT && childEnd >= childStart + 12) {
          node.pivot = [
            view.getFloat32(childStart, true),
            view.getFloat32(childStart + 4, true),
            view.getFloat32(childStart + 8, true),
          ];
        } else if (childId === POS) node.pos = readKeys(view, childStart, childEnd, 3);
        else if (childId === ROT) node.rot = readKeys(view, childStart, childEnd, 4);
        else if (childId === SCL) node.scl = readKeys(view, childStart, childEnd, 3);
      });
      nodes.push(node);
    }
  }

  walk(0, view.byteLength, (id, start, end) => {
    if (id === MAIN) walk(start, end, onMain);
  });

  return { meshes, nodes, masterScale, animationName, frameCount, segment };
}

function hierarchy(nodes) {
  const root = { name: "ROOT", hier: -1, src: null, parent: null, children: [] };
  const add = (parent, child) => {
    child.parent = parent;
    parent.children.push(child);
  };
  let current = root;
  let last = -1;

  function inverseSearch(node, cursor) {
    if (!cursor) {
      add(root, node);
      return;
    }
    if (cursor.hier === node.hier) {
      add(cursor.parent || root, node);
      return;
    }
    inverseSearch(node, cursor.parent);
  }

  nodes.forEach((src) => {
    const name = src.name === "$$$DUMMY" && src.instance ? src.instance : src.name;
    const hier = (src.hier + 1) & 0xffff;
    const node = { name, hier, src, parent: null, children: [] };
    if (current.hier === hier) {
      add(current.parent || root, node);
      last += 1;
    } else if (hier >= last) {
      add(current, node);
      last = hier;
    } else {
      inverseSearch(node, current);
      last += 1;
    }
    current = node;
  });
  return root;
}

function geometryFromMesh(mesh, pivot = [0, 0, 0]) {
  const geometry = new BufferGeometry();
  const inverse = mesh.matrix.clone().invert();
  const local = new Float32Array(mesh.vertices.length);
  const point = new Vector3();
  // 3DS stores the rotation pivot separately from the mesh matrix. Vertices
  // are moved by -pivot in local space so the node origin (and the biped)
  // sits on that point instead of the mesh bounding-box origin.
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    point.set(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]).applyMatrix4(inverse);
    local[i] = point.x - pivot[0];
    local[i + 1] = point.y - pivot[1];
    local[i + 2] = point.z - pivot[2];
  }
  geometry.setAttribute("position", new BufferAttribute(local, 3));
  if (mesh.uvs) geometry.setAttribute("uv", new BufferAttribute(mesh.uvs, 2));
  if (mesh.indices) geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function sampleVector(keys, fallback) {
  if (!keys.length) return fallback;
  return keys[0].values;
}

function isDeformBone(name) {
  return name.startsWith("Bip01") && name !== "Bip01 Foot";
}

function pointSegmentDistance(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  if (lengthSq < 1e-8) return point.distanceTo(a);
  let t = ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  const x = a.x + abx * t - point.x;
  const y = a.y + aby * t - point.y;
  const z = a.z + abz * t - point.z;
  return Math.sqrt(x * x + y * y + z * z);
}

function bindSkin(skin, bones) {
  skin.updateWorldMatrix(true, false);
  bones.forEach((bone) => bone.updateWorldMatrix(true, false));
  const segments = [];
  const head = new Vector3();
  const tail = new Vector3();
  bones.forEach((bone) => {
    bone.getWorldPosition(head);
    const kids = bone.children.filter((child) => child.isBone && child.userData.deform);
    if (kids.length === 0) {
      const parent = bone.parent;
      if (parent?.isBone) {
        parent.getWorldPosition(tail);
        const dir = head.clone().sub(tail);
        const length = dir.length();
        if (length > 1e-4) {
          dir.multiplyScalar(Math.min(18, length * 0.45) / length);
          segments.push({ bone, a: head.clone(), b: head.clone().add(dir), sigma: Math.max(14, length * 0.3) });
        }
      }
      return;
    }
    kids.forEach((kid) => {
      kid.getWorldPosition(tail);
      const length = head.distanceTo(tail);
      segments.push({
        bone,
        a: head.clone(),
        b: tail.clone(),
        sigma: Math.max(16, length * 0.42),
      });
    });
  });

  const position = skin.geometry.attributes.position;
  const count = position.count;
  const boneCount = bones.length;
  const indexOf = new Map(bones.map((bone, index) => [bone, index]));
  let weights = new Float32Array(count * boneCount);
  const vertex = new Vector3();
  for (let i = 0; i < count; i += 1) {
    vertex.fromBufferAttribute(position, i);
    skin.localToWorld(vertex);
    for (let s = 0; s < segments.length; s += 1) {
      const segment = segments[s];
      const distance = pointSegmentDistance(vertex, segment.a, segment.b);
      const influence = Math.exp(-(distance * distance) / (2 * segment.sigma * segment.sigma));
      const slot = i * boneCount + indexOf.get(segment.bone);
      if (influence > weights[slot]) weights[slot] = influence;
    }
  }

  const index = skin.geometry.index;
  const neighbors = Array.from({ length: count }, () => []);
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      neighbors[a].push(b, c);
      neighbors[b].push(a, c);
      neighbors[c].push(a, b);
    }
  }
  for (let pass = 0; pass < 4; pass += 1) {
    const next = new Float32Array(weights.length);
    for (let i = 0; i < count; i += 1) {
      const around = neighbors[i];
      const denom = around.length + 1;
      for (let b = 0; b < boneCount; b += 1) {
        let sum = weights[i * boneCount + b];
        for (let n = 0; n < around.length; n += 1) sum += weights[around[n] * boneCount + b];
        next[i * boneCount + b] = sum / denom;
      }
    }
    weights = next;
  }

  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const ranked = [];
    for (let b = 0; b < boneCount; b += 1) ranked.push([weights[i * boneCount + b], b]);
    ranked.sort((a, b) => b[0] - a[0]);
    let total = 0;
    for (let k = 0; k < 4; k += 1) total += ranked[k][0];
    if (total < 1e-8) {
      skinIndex[i * 4] = 0;
      skinWeight[i * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k += 1) {
      skinIndex[i * 4 + k] = ranked[k][1];
      skinWeight[i * 4 + k] = ranked[k][0] / total;
    }
  }
  skin.geometry.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
  skin.geometry.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));
  const skeleton = new Skeleton(bones);
  skin.bind(skeleton);
  skin.frustumCulled = false;
}

function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name} ${i}`)) i += 1;
  const next = `${name} ${i}`;
  used.add(next);
  return next;
}

export function load3DS(arrayBuffer) {
  const parsed = parse(arrayBuffer);
  const tree = hierarchy(parsed.nodes);
  const root = new Group();
  root.name = "3DSRoot";
  if (parsed.masterScale && parsed.masterScale !== 1) {
    root.scale.setScalar(1 / parsed.masterScale);
  }

  const skinMaterial = new MeshStandardMaterial({
    color: 0x3cae45,
    roughness: 0.58,
    metalness: 0.02,
  });
  const logMaterial = new MeshStandardMaterial({
    color: 0x6d5132,
    roughness: 0.86,
    metalness: 0,
  });
  const boneMaterial = new MeshBasicMaterial({
    color: 0xb6ff9a,
    wireframe: true,
  });

  const usedNames = new Set();
  const bones = [];
  const tracks = [];
  let skin = null;

  function build(node, parent) {
    const src = node.src;
    const name = uniqueName(node.name, usedNames);
    const deform = isDeformBone(name);
    const mesh = parsed.meshes.get(node.name);
    let object;
    if (name === "skin" && mesh?.vertices) {
      object = new SkinnedMesh(geometryFromMesh(mesh, src.pivot), skinMaterial);
      object.userData.sourcePositions = mesh.vertices;
      object.userData.pivot = src.pivot;
      skin = object;
    } else if (deform) {
      object = new Bone();
    } else if (mesh?.vertices) {
      const material = name === "log" ? logMaterial : boneMaterial;
      object = new Mesh(geometryFromMesh(mesh, src.pivot), material);
    } else {
      object = new Group();
    }
    object.name = name;
    object.userData.deform = deform;

    const pos = sampleVector(src.pos, [0, 0, 0]);
    const scl = sampleVector(src.scl, [1, 1, 1]);
    object.position.set(pos[0], pos[1], pos[2]);
    object.scale.set(scl[0] || 1, scl[1] || 1, scl[2] || 1);
    const quats = absoluteQuaternions(src.rot);
    if (quats.length) object.quaternion.copy(quats[0]);

    if (name === "Bip01 Foot") object.visible = false;

    parent.add(object);
    if (deform) bones.push(object);

    if (src.pos.length > 1) {
      const times = [];
      const values = [];
      src.pos.forEach((key) => {
        times.push(key.frame / FPS);
        values.push(key.values[0], key.values[1], key.values[2]);
      });
      tracks.push(new VectorKeyframeTrack(`${name}.position`, times, values));
    }
    // Bip01 is the biped root. Its rotation keys turn the whole animal around
    // the perch, about 110° across the clip. Limb, spine, and head tracks
    // already carry the motion, so the root stays on its first key.
    if (quats.length > 1 && name !== "Bip01") {
      const times = src.rot.map((key) => key.frame / FPS);
      const values = [];
      quats.forEach((q) => values.push(q.x, q.y, q.z, q.w));
      tracks.push(new QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
    }

    node.children.forEach((child) => build(child, object));
  }

  tree.children.forEach((child) => build(child, root));
  root.updateMatrixWorld(true);
  if (skin && bones.length) bindSkin(skin, bones);

  const duration = Math.max(parsed.segment[1], parsed.frameCount) / FPS;
  const clip = new AnimationClip(parsed.animationName || "MAXSCENE", duration, tracks);
  const meta = {
    sourceFile: "test_lizard_01.3DS",
    staticFile: "test_lizard_01.obj",
    animationName: clip.name,
    fps: FPS,
    frameStart: parsed.segment[0],
    frameEnd: parsed.segment[1] || parsed.frameCount,
    skinVertices: skin ? skin.geometry.attributes.position.count : 0,
    deformBones: bones.length,
    sourceTexture: "LIZARD_M.JPG",
    textureFile: "LIZARD_M.png",
    normalFile: "LIZARD_M_normal.png",
    roughnessFile: "LIZARD_M_roughness.png",
  };
  return { object: root, clip, skin, bones, meta };
}

export { FPS };

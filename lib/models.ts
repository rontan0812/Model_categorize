import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { Rhino3dmLoader } from "three/addons/loaders/3DMLoader.js";

/** 一覧に表示する 3D モデルの拡張子 */
export const MODEL_EXTENSIONS = ["stl", "obj", "fbx", "gltf", "glb", "ply", "3mf", "dae", "3dm"] as const;

// Rhino (.3dm) の読み込みには rhino3dm (WebAssembly) を使う。
// ビルド時に public/rhino3dm へコピーしたもの（scripts/copy-rhino3dm.mjs）を読み込む。
const RHINO3DM_PATH = "/rhino3dm/";
let rhinoLoader: Rhino3dmLoader | null = null;

function getRhinoLoader() {
  if (!rhinoLoader) {
    rhinoLoader = new Rhino3dmLoader();
    rhinoLoader.setLibraryPath(RHINO3DM_PATH);
  }
  return rhinoLoader;
}

/** 表示できる形（メッシュ・線・点）が含まれているか */
function hasDrawable(object: THREE.Object3D) {
  let found = false;
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) found = true;
  });
  return found;
}

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

export function isModelFile(path: string): boolean {
  return (MODEL_EXTENSIONS as readonly string[]).includes(extOf(path));
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** "a/b/../c.png" のような相対パスを正規化する */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * モデルファイルを読み込んで three.js の Object3D を返す。
 * glTF のバイナリやテクスチャ、OBJ の MTL など付随ファイルは、
 * 同じフォルダ内から探して読み込む。
 */
export async function loadModel(
  path: string,
  files: Map<string, File>,
): Promise<{ object: THREE.Object3D; dispose: () => void }> {
  const file = files.get(path);
  if (!file) throw new Error("ファイルが見つかりません");

  const baseDir = dirOf(path);
  const blobUrls: string[] = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob:|data:|https?:)/.test(url)) return url;
    let rel = url;
    try {
      rel = decodeURIComponent(url);
    } catch {
      // そのまま使う
    }
    const candidates = [normalize(baseDir + rel), normalize(baseDir + rel.split("/").pop())];
    for (const c of candidates) {
      const f = files.get(c);
      if (f) {
        const u = URL.createObjectURL(f);
        blobUrls.push(u);
        return u;
      }
    }
    return url;
  });
  const dispose = () => blobUrls.forEach((u) => URL.revokeObjectURL(u));

  const meshFromGeometry = (geometry: THREE.BufferGeometry) => {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const hasColor = !!geometry.attributes.color;
    const material = new THREE.MeshStandardMaterial({
      color: hasColor ? 0xffffff : 0xb8c4d6,
      vertexColors: hasColor,
      metalness: 0.1,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geometry, material);
  };

  try {
    const ext = extOf(path);
    let object: THREE.Object3D;
    switch (ext) {
      case "stl":
        object = meshFromGeometry(new STLLoader(manager).parse(await file.arrayBuffer()));
        break;
      case "ply":
        object = meshFromGeometry(new PLYLoader(manager).parse(await file.arrayBuffer()));
        break;
      case "obj": {
        const loader = new OBJLoader(manager);
        const text = await file.text();
        const mtlName = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
        const mtlFile = mtlName ? files.get(normalize(baseDir + mtlName)) : undefined;
        if (mtlFile) {
          const materials = new MTLLoader(manager).parse(await mtlFile.text(), "");
          materials.preload();
          loader.setMaterials(materials);
        }
        object = loader.parse(text);
        break;
      }
      case "gltf":
      case "glb": {
        const data = ext === "glb" ? await file.arrayBuffer() : await file.text();
        const gltf = await new GLTFLoader(manager).parseAsync(data, "");
        object = gltf.scene;
        break;
      }
      case "fbx":
        object = new FBXLoader(manager).parse(await file.arrayBuffer(), "");
        break;
      case "3mf":
        object = new ThreeMFLoader(manager).parse(await file.arrayBuffer());
        break;
      case "dae": {
        const collada = new ColladaLoader(manager).parse(await file.text(), "");
        if (!collada) throw new Error("Collada の読み込みに失敗しました");
        object = collada.scene;
        break;
      }
      case "3dm": {
        let rhino: THREE.Object3D;
        try {
          rhino = await getRhinoLoader().parseAsync(await file.arrayBuffer());
        } catch (e) {
          throw new Error(`Rhino ファイルを読み込めませんでした: ${e instanceof Error ? e.message : e}`);
        }
        if (!hasDrawable(rhino)) {
          throw new Error("表示できる形状がありません。Rhino で表示用メッシュを含めて保存すると表示できます");
        }
        // 部品一覧でレイヤー名ごとにまとめられるようにする
        const layers = (rhino.userData.layers ?? []) as { name?: string; fullPath?: string }[];
        rhino.traverse((o) => {
          const layer = layers[o.userData.attributes?.layerIndex];
          if (layer) o.userData.partName = layer.fullPath || layer.name;
        });
        // Rhino は Z 軸が上なので、Y 軸が上の three.js に合わせて起こす
        rhino.rotation.x = -Math.PI / 2;
        object = new THREE.Group().add(rhino);
        break;
      }
      default:
        throw new Error(`未対応の形式です: .${ext}`);
    }
    return { object, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/** 頂点数・ポリゴン数・サイズ */
export function modelStats(object: THREE.Object3D) {
  let vertices = 0;
  let triangles = 0;
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const count = g.attributes.position?.count ?? 0;
    vertices += count;
    triangles += g.index ? g.index.count / 3 : count / 3;
  });
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return { vertices, triangles: Math.round(triangles), size };
}

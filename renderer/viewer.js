import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    // occtimportjs is loaded as a classic global script (see index.html) —
    // it locates its own .wasm file relative to itself by default.
    occtPromise = window.occtimportjs();
  }
  return occtPromise;
}

function addTreeNode(container, name, onToggle, hasChildren) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.addEventListener('change', () => onToggle(checkbox.checked));
  label.append(checkbox, document.createTextNode(name || '(unnamed)'));
  container.appendChild(label);

  if (!hasChildren) return null;

  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'children';
  container.appendChild(childrenContainer);
  return childrenContainer;
}

function buildAssembly(node, meshObjects, parentThreeGroup, domContainer, fallbackName) {
  const group = new THREE.Group();
  group.name = node.name || fallbackName || 'Assembly';
  parentThreeGroup.add(group);

  const childrenDom = addTreeNode(domContainer, group.name, (visible) => {
    group.visible = visible;
  }, true);

  for (const meshIndex of node.meshes || []) {
    const mesh = meshObjects[meshIndex];
    if (!mesh) continue;
    group.add(mesh);
    addTreeNode(childrenDom, mesh.name || `Part ${meshIndex + 1}`, (visible) => {
      mesh.visible = visible;
    }, false);
  }

  for (const child of node.children || []) {
    buildAssembly(child, meshObjects, group, childrenDom, null);
  }

  return group;
}

function meshFromResult(meshData, index) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(meshData.attributes.position.array, 3));
  if (meshData.attributes.normal) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(meshData.attributes.normal.array, 3));
  }
  geometry.setIndex(meshData.index.array);
  if (!meshData.attributes.normal) geometry.computeVertexNormals();

  const color = meshData.color
    ? new THREE.Color(meshData.color[0], meshData.color[1], meshData.color[2])
    : new THREE.Color(0x9db8d6);
  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = meshData.name || `Part ${index + 1}`;
  return mesh;
}

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x9db8d6, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide });
}

function fitCameraToBox(camera, controls, box, offset = 1.6) {
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = camera.fov * (Math.PI / 180);
  const cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * offset;

  camera.position.set(center.x + cameraDist, center.y + cameraDist * 0.6, center.z + cameraDist);
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

export function createViewer({ container, treeContainer, messageEl }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e1f22);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(5, 4, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(5, 10, 7.5);
  scene.add(dirLight);

  let currentModel = null;
  let gridHelper = null;

  // Sized and positioned to the loaded model each time, since files come in
  // wildly different scales (a few mm to a few meters).
  function updateGrid(box) {
    if (gridHelper) {
      scene.remove(gridHelper);
      gridHelper.geometry.dispose();
      gridHelper.material.dispose();
      gridHelper = null;
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const gridSize = maxDim * 3;
    gridHelper = new THREE.GridHelper(gridSize, 20, 0x55565c, 0x35363a);
    gridHelper.position.set(center.x, box.min.y, center.z);
    scene.add(gridHelper);
  }

  function setBackground(color) {
    scene.background = new THREE.Color(color);
  }

  function resize() {
    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  function clear() {
    if (currentModel) {
      scene.remove(currentModel);
      currentModel.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      currentModel = null;
    }
    treeContainer.innerHTML = '';
  }

  function showModel(root) {
    scene.add(root);
    currentModel = root;
    const box = new THREE.Box3().setFromObject(root);
    fitCameraToBox(camera, controls, box);
    updateGrid(box);
  }

  // Shared by STEP/IGES/BREP — occt-import-js returns the same
  // {success, root, meshes} shape regardless of which Read* function
  // parsed the file, so only the entry point differs.
  async function loadOcctFile(uint8Array, fileName, readMethod) {
    clear();
    if (messageEl) messageEl.textContent = 'Parsing ' + fileName + '…';

    const occt = await getOcct();
    const result = occt[readMethod](uint8Array, null);

    if (!result.success) {
      if (messageEl) messageEl.textContent = 'Failed to parse ' + fileName + '.';
      throw new Error('occt-import-js failed to parse ' + fileName);
    }

    const meshObjects = result.meshes.map(meshFromResult);
    const root = new THREE.Group();
    buildAssembly(result.root, meshObjects, root, treeContainer, fileName);
    showModel(root);
    if (messageEl) messageEl.textContent = '';
    return { meshCount: result.meshes.length };
  }

  function loadStep(uint8Array, fileName) {
    return loadOcctFile(uint8Array, fileName, 'ReadStepFile');
  }
  function loadIges(uint8Array, fileName) {
    return loadOcctFile(uint8Array, fileName, 'ReadIgesFile');
  }
  function loadBrep(uint8Array, fileName) {
    return loadOcctFile(uint8Array, fileName, 'ReadBrepFile');
  }

  // For meshes already decoded elsewhere (e.g. the SLDPRT tessellation
  // decoder) — just positions/normals/indices, no parsing needed here.
  function loadMesh({ positions, normals, indices }, fileName) {
    clear();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const mesh = new THREE.Mesh(geometry, defaultMaterial());
    mesh.name = fileName;

    const root = new THREE.Group();
    root.add(mesh);
    addTreeNode(treeContainer, fileName, (visible) => {
      mesh.visible = visible;
    }, false);

    showModel(root);
    if (messageEl) messageEl.textContent = '';
    return { triangleCount: indices.length / 3 };
  }

  function loadStl(uint8Array, fileName) {
    clear();
    const loader = new STLLoader();
    const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength);
    const geometry = loader.parse(arrayBuffer);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, defaultMaterial());
    mesh.name = fileName;

    const root = new THREE.Group();
    root.add(mesh);
    addTreeNode(treeContainer, fileName, (visible) => {
      mesh.visible = visible;
    }, false);

    showModel(root);
    if (messageEl) messageEl.textContent = '';
    const triangleCount = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    return { triangleCount };
  }

  // OBJ is text, not binary — the caller decodes bytes to a string first.
  function loadObj(text, fileName) {
    clear();
    const loader = new OBJLoader();
    const root = loader.parse(text);

    let leafIndex = 0;
    root.traverse((child) => {
      if (!child.isMesh) return;
      if (child.material) child.material.side = THREE.DoubleSide;
      addTreeNode(treeContainer, child.name || `Part ${++leafIndex}`, (visible) => {
        child.visible = visible;
      }, false);
    });

    showModel(root);
    if (messageEl) messageEl.textContent = '';
    return { partCount: leafIndex };
  }

  function loadGltf(arrayBuffer, fileName) {
    clear();
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.parse(
        arrayBuffer,
        '',
        (gltf) => {
          const root = gltf.scene || gltf.scenes[0];
          let leafIndex = 0;
          root.traverse((child) => {
            if (!child.isMesh) return;
            if (child.material) child.material.side = THREE.DoubleSide;
            leafIndex++;
          });
          addTreeNode(treeContainer, fileName, () => {
            root.visible = !root.visible;
          }, false);
          showModel(root);
          if (messageEl) messageEl.textContent = '';
          resolve({ partCount: leafIndex });
        },
        (err) => reject(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }

  return { loadStep, loadIges, loadBrep, loadStl, loadObj, loadGltf, loadMesh, clear, resize, setBackground };
}

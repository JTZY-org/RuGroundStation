// 网页框人：在地面端使用最新 YOLO11n 模型，基于 WebGL 硬件加速对当前视频帧进行实时目标检测。
// 支持 640x640 高分辨率输入、Letterbox 等比自适应缩放与高效 NMS 过滤。

import * as ort from 'onnxruntime-web';

const SCORE_THRESHOLD = 0.35;
const IOU_THRESHOLD = 0.45;
const MODEL_INPUT_SIZE = 640;

let loadPromise = null;
let session = null;
let offscreenCanvas = null;
let offscreenCtx = null;
let inputBuffer = null; // 预分配输入缓存，避免每帧触发垃圾回收

function assetUrl(name) {
  return new URL(name, window.location.href).href;
}

// 加载类别标签
async function loadLabels() {
  try {
    const response = await fetch(assetUrl('models/labelmap.txt'));
    if (!response.ok) return ['person'];
    const text = await response.text();
    const list = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return list.length > 0 ? list : ['person'];
  } catch {
    return ['person'];
  }
}

function iou(a, b) {
  const x1 = Math.max(a.left, b.left);
  const y1 = Math.max(a.top, b.top);
  const x2 = Math.min(a.right, b.right);
  const y2 = Math.min(a.bottom, b.bottom);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.right - a.left) * (a.bottom - a.top);
  const areaB = (b.right - b.left) * (b.bottom - b.top);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function applyNms(boxes) {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const selected = [];
  while (sorted.length > 0) {
    const first = sorted.shift();
    selected.push(first);
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (iou(first, sorted[i]) >= IOU_THRESHOLD) {
        sorted.splice(i, 1);
      }
    }
  }
  return selected;
}

// 初始化并加载 YOLO11 ONNX 会话（优先 WebGL 硬件加速）
async function loadSession() {
  // 配置 WASM 静态资源路径
  ort.env.wasm.wasmPaths = assetUrl('');
  ort.env.wasm.numThreads = 1;

  const modelUrl = assetUrl('models/yolo11n.onnx');
  const labels = await loadLabels();

  // 首选 WebGL 硬件加速，失败时自动平滑回退至 WASM
  let ortSession = null;
  try {
    ortSession = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['webgl', 'wasm'],
      graphOptimizationLevel: 'all'
    });
  } catch (err) {
    console.warn('[YOLO11] WebGL init fallback to wasm:', err);
    ortSession = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
  }

  // 预创建 Canvas 和输入内存缓冲
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = MODEL_INPUT_SIZE;
    offscreenCanvas.height = MODEL_INPUT_SIZE;
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    inputBuffer = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
  }

  session = {
    ortSession,
    inputSize: MODEL_INPUT_SIZE,
    labels
  };
  return session;
}

export function ensurePersonModel() {
  if (session) return Promise.resolve(session);
  if (!loadPromise) {
    loadPromise = loadSession().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

export async function detectPersons(video, options = {}) {
  const current = session || await ensurePersonModel();
  const width = video?.videoWidth || video?.naturalWidth || video?.width || 0;
  const height = video?.videoHeight || video?.naturalHeight || video?.height || 0;
  const ready = video?.readyState == null || video.readyState >= 2 || video?.complete;
  if (!video || !ready || !width || !height) return [];

  const S = current.inputSize;
  const ctx = offscreenCtx;

  // 1. 等比例自适应缩放（Letterbox），避免画面拉伸形变导致特征失真
  const scale = Math.min(S / width, S / height);
  const nw = Math.round(width * scale);
  const nh = Math.round(height * scale);
  const padX = Math.floor((S - nw) / 2);
  const padY = Math.floor((S - nh) / 2);

  // 填充灰底背景 (RGB 114, 114, 114)
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, S, S);

  ctx.save();
  if (options.upright) {
    // 画面旋转 180 度矫正
    ctx.translate(padX + nw / 2, padY + nh / 2);
    ctx.rotate(Math.PI);
    ctx.drawImage(video, 0, 0, width, height, -nw / 2, -nh / 2, nw, nh);
  } else {
    ctx.drawImage(video, 0, 0, width, height, padX, padY, nw, nh);
  }
  ctx.restore();

  // 2. 提取像素并转为 NCHW Float32Array [1, 3, 640, 640]，范围 0.0 ~ 1.0
  const imageData = ctx.getImageData(0, 0, S, S);
  const pixels = imageData.data;
  const area = S * S;
  const ch0 = 0;
  const ch1 = area;
  const ch2 = area * 2;

  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    inputBuffer[ch0 + i] = pixels[p] / 255.0;
    inputBuffer[ch1 + i] = pixels[p + 1] / 255.0;
    inputBuffer[ch2 + i] = pixels[p + 2] / 255.0;
  }

  const tensor = new ort.Tensor('float32', inputBuffer, [1, 3, S, S]);

  // 3. 执行 WebGL 推理
  let feeds = {};
  const inputName = current.ortSession.inputNames[0] || 'images';
  feeds[inputName] = tensor;

  const results = await current.ortSession.run(feeds);
  const output = results.output0 || Object.values(results)[0];
  const data = output.data; // Float32Array, shape: [1, 84, 8400]

  // 4. 解析 YOLO11 预测输出并过滤人体
  const numAnchors = 8400;
  const personChannel = 4; // COCO 类别 0 (person)
  const candidates = [];

  for (let i = 0; i < numAnchors; i += 1) {
    const score = data[personChannel * numAnchors + i];
    if (score < SCORE_THRESHOLD) continue;

    const cx = data[0 * numAnchors + i];
    const cy = data[1 * numAnchors + i];
    const bw = data[2 * numAnchors + i];
    const bh = data[3 * numAnchors + i];

    // 从 Letterbox 坐标反算回原始视频坐标并归一化 (0.0 ~ 1.0)
    const x1 = (cx - bw / 2 - padX) / nw;
    const y1 = (cy - bh / 2 - padY) / nh;
    const x2 = (cx + bw / 2 - padX) / nw;
    const y2 = (cy + bh / 2 - padY) / nh;

    const left = Math.max(0, Math.min(1, x1));
    const top = Math.max(0, Math.min(1, y1));
    const right = Math.max(0, Math.min(1, x2));
    const bottom = Math.max(0, Math.min(1, y2));

    if (right <= left || bottom <= top) continue;

    candidates.push({
      left,
      top,
      right,
      bottom,
      score,
      label: 'person'
    });
  }

  // 5. 应用非极大值抑制（NMS）消除重叠重合框
  return applyNms(candidates);
}

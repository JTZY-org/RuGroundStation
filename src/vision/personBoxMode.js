// 网页端目标检测（实验性）：在用户真正需要并配置好依赖时加载。
// 当前生产环境优先使用天空端 RK3566 NPU 回传的 0xFE 检测框。

export async function ensurePersonModel() {
  throw new Error('地面端 YOLO 模块未激活。当前系统默认使用天空机载端 NPU 识别回传框。');
}

export async function detectPersons(video, options = {}) {
  return [];
}

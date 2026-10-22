const STORAGE_KEY_AMAP_KEY = 'amap_jsapi_key';
const STORAGE_KEY_AMAP_SEC = 'amap_security_js_code';

// 默认内置一套或从 LocalStorage / Env 读取
export function getAmapKeys() {
  const localKey = (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_AMAP_KEY) : '') || '';
  const localSec = (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_AMAP_SEC) : '') || '';

  const envKey = (import.meta.env?.VITE_AMAP_JSAPI_KEY || '').trim();
  const envSec = (import.meta.env?.VITE_AMAP_SECURITY_JS_CODE || '').trim();

  // 优先级：用户手动填写的 LocalStorage > .env
  const key = (localKey || envKey).trim();
  const security = (localSec || envSec).trim();

  return {
    key,
    security,
    isConfigured: Boolean(key && security),
  };
}

export function saveAmapKeys(key, security) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY_AMAP_KEY, (key || '').trim());
    localStorage.setItem(STORAGE_KEY_AMAP_SEC, (security || '').trim());
  }
}


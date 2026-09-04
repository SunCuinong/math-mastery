'use strict';

/* ============ 跨页选图传递 ============
   首页顶栏「拍照 / 相册」在 admin.html 内直接调起系统相机/相册（同页用户手势，
   避免 iOS 对跨页自动触发 file input 的限制）。选完图后用 IndexedDB 暂存，
   再跳转到 index.html 框选上传。用 IDB 而非 sessionStorage，是因为相册大图
   base64 后可能超过 sessionStorage 约 5MB 的容量。 */

(function (global) {
  const DB_NAME = 'math_mastery_pickpass';
  const STORE = 'pending';
  const KEY = 'image';
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  // 暂存待框选图片（Blob/File）。
  function savePending(blob) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // 取出并清除待框选图片；无则返回 null。
  function takePending() {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = () => {
        const blob = req.result || null;
        store.delete(KEY);   // 取走即清除，避免下次误用
        resolve(blob);
      };
      req.onerror = () => reject(req.error);
    }));
  }

  global.PickPass = { savePending, takePending };
})(window);

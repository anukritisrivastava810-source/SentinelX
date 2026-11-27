/* Runs in the page's main world and reports actual browser permission API use. */
(() => {
  if (window.__sentinelx_permission_bridge_installed) return;
  window.__sentinelx_permission_bridge_installed = true;

  const report = permission => {
    try {
      window.dispatchEvent(new CustomEvent('sentinelx-permission-request', {
        detail: { permission, timestamp: Date.now() }
      }));
    } catch {
      // Ignore if event dispatch fails in restricted context
    }
  };

  try {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = function (constraints) {
        if (constraints?.video) report('camera');
        if (constraints?.audio) report('microphone');
        return originalGetUserMedia(constraints);
      };
    }
  } catch {}

  try {
    if (navigator.geolocation) {
      if (typeof navigator.geolocation.getCurrentPosition === 'function') {
        const originalGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
        navigator.geolocation.getCurrentPosition = function (...args) {
          report('geolocation');
          return originalGetCurrentPosition(...args);
        };
      }
      if (typeof navigator.geolocation.watchPosition === 'function') {
        const originalWatchPosition = navigator.geolocation.watchPosition.bind(navigator.geolocation);
        navigator.geolocation.watchPosition = function (...args) {
          report('geolocation');
          return originalWatchPosition(...args);
        };
      }
    }
  } catch {}

  try {
    if (typeof window.Notification !== 'undefined' && typeof window.Notification.requestPermission === 'function') {
      const originalRequestPermission = window.Notification.requestPermission.bind(window.Notification);
      window.Notification.requestPermission = function (...args) {
        report('notifications');
        return originalRequestPermission(...args);
      };
    }
  } catch {}

  try {
    if (navigator.clipboard) {
      const methods = [
        ['readText', 'clipboard-read'],
        ['read', 'clipboard-read'],
        ['writeText', 'clipboard-write'],
        ['write', 'clipboard-write']
      ];
      for (const [method, permission] of methods) {
        if (typeof navigator.clipboard[method] === 'function') {
          const originalMethod = navigator.clipboard[method].bind(navigator.clipboard);
          navigator.clipboard[method] = function (...args) {
            report(permission);
            return originalMethod(...args);
          };
        }
      }
    }
  } catch {}
})();

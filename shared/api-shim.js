/* API promise shim — Firefox's chrome.* namespace is callback-only, while the
   shared code (written for Chrome MV3) awaits chrome.* as promises. Where the
   promise-based browser.* namespace exists (Firefox), expose chrome as a thin
   adapter over it: async methods return promises, callback-style calls still
   work (the callback is invoked with the resolved value), and events and
   synchronous members (runtime.getURL, getManifest, …) pass through untouched.
   No-op on Chrome, which has no browser.* namespace and whose chrome.* already
   returns promises. Must load BEFORE any code that calls chrome.*.
   Audit: see AUDIT.md#api-shim — a broken shim silently disables every
   promise-style security path (storage reads, the bridge, the Origin rule). */
(() => {
  const B = globalThis.browser;
  if (!B || !B.runtime || !B.runtime.getURL || !globalThis.chrome) return;
  const isEvent = o => o && typeof o.addListener === 'function' && typeof o.removeListener === 'function';
  const wrapFn = (fn, owner) => function (...args) {
    const last = args[args.length - 1];
    if (typeof last === 'function' && !isEvent(owner)) {
      // Callback-style call: browser.* methods take no callbacks.
      const cb = args.pop();
      let r;
      try { r = fn.apply(owner, args); } catch (e) { try { cb(undefined); } catch {} throw e; }
      if (r && typeof r.then === 'function') r.then(v => cb(v), () => cb(undefined));
      else cb(r);
      return undefined;
    }
    return fn.apply(owner, args);
  };
  const wrap = obj => new Proxy(obj, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v === 'function') return wrapFn(v, t);
      if (v && typeof v === 'object' && !isEvent(v)) return wrap(v);
      return v;
    }
  });
  const shim = wrap(B);
  try { globalThis.chrome = shim; }
  catch { Object.defineProperty(globalThis, 'chrome', { value: shim, configurable: true, writable: true }); }
})();

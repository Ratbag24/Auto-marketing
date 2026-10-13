/**
 * The tracking snippet, served from /t.js.
 *
 * Deliberately tiny and dependency-free. It sets no cookies and reads no
 * storage beyond a per-tab session id in sessionStorage, so it needs no cookie
 * banner under GDPR/PECR in most jurisdictions. Confirm that for your own
 * jurisdiction before relying on it.
 */
export function trackerScript(collectUrl: string): string {
  return `(function () {
  "use strict";
  var KEY = (document.currentScript && document.currentScript.getAttribute("data-key")) || "";
  if (!KEY) return;
  if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;

  function sessionId() {
    try {
      var id = sessionStorage.getItem("am_sid");
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem("am_sid", id);
      }
      return id;
    } catch (e) {
      // Private mode or blocked storage: fall back to a per-pageview id.
      return Math.random().toString(36).slice(2);
    }
  }

  var started = Date.now();
  var sid = sessionId();
  var sent = false;

  function params() {
    try { return new URLSearchParams(location.search); }
    catch (e) { return { get: function () { return null; } }; }
  }

  function payload(event, duration) {
    var q = params();
    var tz = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    return JSON.stringify({
      k: KEY,
      e: event,
      p: location.pathname + location.search,
      r: document.referrer || null,
      tz: tz,
      lang: navigator.language || null,
      sid: sid,
      d: duration || 0,
      us: q.get("utm_source"),
      um: q.get("utm_medium"),
      uc: q.get("utm_campaign")
    });
  }

  function send(event, duration) {
    var body = payload(event, duration);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(${JSON.stringify(collectUrl)}, new Blob([body], { type: "text/plain" }));
        return;
      }
    } catch (e) {}
    try {
      fetch(${JSON.stringify(collectUrl)}, {
        method: "POST", body: body, keepalive: true,
        headers: { "Content-Type": "text/plain" }
      });
    } catch (e) {}
  }

  send("view", 0);

  // Report how long the visitor stayed, once, when the page goes away.
  function finish() {
    if (sent) return;
    sent = true;
    send("leave", Date.now() - started);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") finish();
  });
  window.addEventListener("pagehide", finish);

  // Single-page apps change the URL without reloading.
  var lastPath = location.pathname;
  function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    started = Date.now();
    sent = false;
    send("view", 0);
  }
  var pushState = history.pushState;
  history.pushState = function () {
    pushState.apply(this, arguments);
    onRoute();
  };
  window.addEventListener("popstate", onRoute);
})();`;
}

/** The snippet a business pastes into their site, shown in the dashboard. */
export function snippetFor(baseUrl: string, trackingKey: string): string {
  return `<script defer src="${baseUrl}/t.js" data-key="${trackingKey}"></script>`;
}

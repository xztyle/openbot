// The service worker of the OpenBot web app. It does one thing: it shows the push notification that
// the user's own OpenBot host sent, also when no page of the app is open, and opens the chat when the
// user taps it. It has no fetch handler and keeps no cache, so it never sees or stores a request
// to /api/browser/*, and the app always loads from the network.
//
// The message was encrypted by the host for this browser. It holds the agent's name, a fixed phrase
// for the kind of event, and ids. It never holds the text of a chat.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("push", (event) => {
  event.waitUntil(showNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  event.waitUntil(openChat(data.hostId, data.agentId));
});

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

async function showNotification(event) {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // A message that is not JSON still shows the app name.
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // A page that the user looks at shows the event itself, with its own sound.
  if (windows.some((client) => client.visibilityState === "visible" && client.focused)) return;
  const agentId = text(message.agentId, 128);
  await self.registration.showNotification(text(message.title, 120) || "OpenBot", {
    body: text(message.body, 200),
    icon: "/icon-192x192.png",
    // One notification for each agent: a newer event of the same agent replaces the older one.
    tag: agentId ? `agent:${agentId}` : "openbot",
    renotify: true,
    data: { hostId: text(message.hostId, 128), agentId },
  });
}

async function openChat(hostId, agentId) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const page = windows.find((client) => /^\/app\/?$/u.test(new URL(client.url).pathname));
  if (page) {
    await page.focus();
    page.postMessage({ type: "openbot:open-chat", hostId, agentId });
    return;
  }
  const url = new URL("/app", self.location.origin);
  if (hostId && agentId) {
    url.searchParams.set("host", hostId);
    url.searchParams.set("chat", agentId);
  }
  await self.clients.openWindow(url.href);
}

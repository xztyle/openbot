// The service worker of the OpenBot web app. It does one thing: it shows the push notification that
// the user's own OpenBot host sent, also when no page of the app is open, and opens the chat when the
// user taps it. It has no fetch handler and keeps no cache, so it never sees or stores a request
// to /api/browser/*, and the app always loads from the network.
//
// The message was encrypted by the host for this browser. It holds the name of the agent or the author,
// the name of the conversation, a fixed phrase for the kind of event, ids, and the address of the place.
// It never holds the text of a chat.
//
// Each push shows a notification. WebKit (iPhone and iPad) takes back the push permission of a site that
// receives a push and shows nothing. So a push that arrives while the user looks at the app shows its
// notification and closes it at once.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("push", (event) => {
  event.waitUntil(showNotification(event));
});

// The push service gave the browser another address. The page tells the host the new one: the host cannot
// reach this browser until then. A page that is not open does it when it opens, as it does at each connect.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(tellPages());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  event.waitUntil(openChat(data));
});

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

// The address of the place the event is about, such as `/app/s/<host>/<space>/c/<channel>/t/<root>/m/<message>`.
// Only a path of the web client: a push names no other page.
function appPath(value) {
  const path = text(value, 1024);
  return /^\/app(?:\/[\w%.~-]+)*$/u.test(path) ? path : "";
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
  const watched = windows.some((client) => client.visibilityState === "visible" && client.focused);
  const agentId = text(message.agentId, 128);
  // One notification for each conversation, as the host names it: a newer event of the same conversation
  // replaces the older one. A host from before conversation tags names the agent only.
  const tag = text(message.tag, 256) || (agentId ? `agent:${agentId}` : "openbot");
  // The host counts the messages of a burst in one more notice, which replaces the first one quietly.
  const update = message.update === true;
  await self.registration.showNotification(text(message.title, 120) || "OpenBot", {
    body: text(message.body, 200),
    icon: "/icon-192x192.png",
    tag,
    renotify: !watched && !update,
    silent: watched || update,
    data: {
      hostId: text(message.hostId, 128),
      agentId,
      threadId: text(message.threadId, 128),
      path: appPath(message.path),
    },
  });
  if (!watched) return;
  for (const notification of await self.registration.getNotifications({ tag })) notification.close();
}

async function tellPages() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: "openbot:push-changed", scope: self.registration.scope });
}

// Opens the place of the event: the address it names, else the agent's chat, or the channel of the agent's
// thread (`threadId`), which the page finds in its channel list.
async function openChat(data) {
  const hostId = text(data.hostId, 128);
  const agentId = text(data.agentId, 128);
  const threadId = text(data.threadId, 128);
  const path = appPath(data.path);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // The web client shows its place in the path, `/app/<space>/c/<channel>`, so any page under /app is one.
  const page = windows.find((client) => /^\/app(?:\/.*)?$/u.test(new URL(client.url).pathname));
  if (page) {
    await page.focus();
    page.postMessage({ type: "openbot:open-chat", hostId, agentId, threadId, path });
    return;
  }
  if (path) {
    await self.clients.openWindow(new URL(path, self.location.origin).href);
    return;
  }
  const url = new URL("/app", self.location.origin);
  if (hostId && agentId) {
    url.searchParams.set("host", hostId);
    url.searchParams.set("chat", agentId);
    if (threadId) url.searchParams.set("thread", threadId);
  }
  await self.clients.openWindow(url.href);
}

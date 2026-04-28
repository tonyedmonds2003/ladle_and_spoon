// ════════════════════════════════════════════════════════════════
//  Ladle & Spoon — Firebase Cloud Messaging Service Worker
//  File name: firebase-messaging-sw.js
//  Must be in the ROOT of your GitHub repo alongside index.html
//  Version: 3
// ════════════════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDYt3OeHN0yorpDAWu4MPvH55GnkO_yD44",
  authDomain:        "ladle-and-spoon-push-notify.firebaseapp.com",
  projectId:         "ladle-and-spoon-push-notify",
  storageBucket:     "ladle-and-spoon-push-notify.firebasestorage.app",
  messagingSenderId: "432229384791",
  appId:             "1:432229384791:web:4db16a355c485a91a95912"
});

const messaging = firebase.messaging();

// Handle background notifications (app closed or not in focus)
// Uses 'tag' to collapse duplicates — only one notification shows at a time
messaging.onBackgroundMessage(function(payload) {
  console.log('[SW] Background message received:', JSON.stringify(payload));

  // Read from data payload (sent as data-only from Apps Script)
  // Fall back to notification payload just in case
  const title = (payload.data && payload.data.title) || 
                (payload.notification && payload.notification.title) || 
                'Ladle & Spoon';
  const body  = (payload.data && payload.data.body) ||
                (payload.notification && payload.notification.body) ||
                "Check this week's menu!";
  const url   = (payload.data && payload.data.url) ||
                'https://tonyedmonds2003.github.io/ladle_and_spoon/';
  const icon  = (payload.data && payload.data.icon) ||
                'https://res.cloudinary.com/drcjmvjc9/image/upload/v1762996224/Ladle_and_Spoon_Logo_Clean_pylcav.png';

  const options = {
    body:             body,
    icon:             icon,
    badge:            icon,
    tag:              'ladle-spoon-notification',
    renotify:         false,
    requireInteraction: false,
    data:             { url: url }
  };

  console.log('[SW] Showing notification:', title, body, url);
  return self.registration.showNotification(title, options);
});

// Tap notification to open the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || 'https://tonyedmonds2003.github.io/ladle_and_spoon/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) {
          clientList[i].navigate(url);
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

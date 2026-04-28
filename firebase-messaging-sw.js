// ════════════════════════════════════════════════════════════════
//  Ladle & Spoon — Firebase Cloud Messaging Service Worker
//  This file MUST be named firebase-messaging-sw.js
//  and uploaded to GitHub alongside index.html
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

// Handle background notifications (when app is closed or tab not active)
messaging.onBackgroundMessage(function(payload) {
  console.log('Background message received:', payload);

  const title   = (payload.notification && payload.notification.title) || '🥣 Ladle & Spoon';
  const options = {
    body: (payload.notification && payload.notification.body) || 'Check this week\'s menu!',
    icon: 'https://res.cloudinary.com/drcjmvjc9/image/upload/v1762996224/Ladle_and_Spoon_Logo_Clean_pylcav.png',
    badge: 'https://res.cloudinary.com/drcjmvjc9/image/upload/v1762996224/Ladle_and_Spoon_Logo_Clean_pylcav.png',
    tag:  'ladle-spoon-notification',
    data: { url: payload.data && payload.data.url ? payload.data.url : self.location.origin }
  };

  self.registration.showNotification(title, options);
});

// When customer taps the notification — open the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // If app is already open, focus it
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url === url && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

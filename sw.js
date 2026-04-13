self.addEventListener('push', function(event) {
    const data = event.data.json();
    const options = {
        body: data.body,
        icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2504/2504824.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/2504/2504824.png',
        vibrate: [200, 100, 200]
    };
    event.waitUntil(
        self.notificationRegistration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});
// Service Worker для JSculptor AI v4.0
self.addEventListener('push', function(event) {
    if (event.data) {
        const data = event.data.json();
        const options = {
            body: data.body,
            icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2504/2504824.png',
            badge: 'https://cdn-icons-png.flaticon.com/512/2504/2504824.png',
            vibrate: [200, 100, 200],
            data: {
                dateOfArrival: Date.now(),
                primaryKey: '1'
            },
            actions: [
                {action: 'explore', title: 'Открыть терминал'}
            ]
        };

        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});
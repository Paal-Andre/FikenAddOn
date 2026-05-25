const CACHE_NAME = "fiken-addon-v2";
const APP_SHELL = [
	"/",
	"/index.html",
	"/auth.html",
	"/styles.css",
	"/app.js",
	"/auth.js",
	"/pwa-install.js",
	"/manifest.webmanifest",
	"/icon.svg"
];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys
					.filter((key) => key !== CACHE_NAME)
					.map((key) => caches.delete(key))
			)
		)
	);
	self.clients.claim();
});

self.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") {
		return;
	}

	const requestUrl = new URL(event.request.url);
	const path = requestUrl.pathname;

	// OAuth and API traffic must bypass cache so redirects and session state stay correct.
	if (path.startsWith("/auth/") || path.startsWith("/api/")) {
		return;
	}

	event.respondWith(
		caches.match(event.request).then((cached) => {
			if (cached) {
				return cached;
			}

			return fetch(event.request)
				.then((response) => {
					if (!response || response.status !== 200 || response.type !== "basic") {
						return response;
					}
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
					return response;
				})
				.catch(() => caches.match("/"));
		})
	);
});

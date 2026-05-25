let deferredPrompt = null;
const installBtn = document.getElementById("install-app-btn");
const installHelp = document.getElementById("install-help");

function isIos() {
	return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function isMobileDevice() {
	if (window.navigator.userAgentData && typeof window.navigator.userAgentData.mobile === "boolean") {
		return window.navigator.userAgentData.mobile;
	}

	return /android|iphone|ipad|ipod|mobile/i.test(window.navigator.userAgent);
}

function isInStandaloneMode() {
	return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function setHelp(text) {
	if (!installHelp) {
		return;
	}
	installHelp.textContent = text;
}

function showInstallButton() {
	if (!installBtn) {
		return;
	}
	installBtn.classList.add("is-visible");
}

function hideInstallButton() {
	if (!installBtn) {
		return;
	}
	installBtn.classList.remove("is-visible");
}

async function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) {
		return;
	}
	try {
		await navigator.serviceWorker.register("/service-worker.js");
	} catch {
		// Ignore registration failures for unsupported environments.
	}
}

window.addEventListener("beforeinstallprompt", (event) => {
	if (!isMobileDevice()) {
		return;
	}

	event.preventDefault();
	deferredPrompt = event;
	showInstallButton();
	setHelp("");
});

window.addEventListener("appinstalled", () => {
	deferredPrompt = null;
	hideInstallButton();
	setHelp("Appen er installert på hjemskjermen.");
});

if (installBtn) {
	installBtn.addEventListener("click", async () => {
		if (deferredPrompt) {
			deferredPrompt.prompt();
			await deferredPrompt.userChoice;
			deferredPrompt = null;
			return;
		}

		if (isIos() && !isInStandaloneMode()) {
			setHelp("I Safari: trykk Del-knappen og velg Legg til på Hjem-skjerm.");
			return;
		}

		setHelp("Installering er ikke tilgjengelig i denne nettleseren akkurat nå.");
	});
}

(async function initInstallSupport() {
	if (!isMobileDevice()) {
		hideInstallButton();
		setHelp("");
		return;
	}

	await registerServiceWorker();

	if (isInStandaloneMode()) {
		hideInstallButton();
		setHelp("Appen kjører allerede fra hjemskjermen.");
		return;
	}

	if (isIos()) {
		showInstallButton();
		setHelp("Bruk Del-knappen i Safari for å legge appen på hjemskjermen.");
	}
})();

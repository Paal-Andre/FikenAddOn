const messageBox = document.getElementById("message");
const clientIdInput = document.getElementById("client-id-input");
const clientSecretInput = document.getElementById("client-secret-input");
const saveBtn = document.getElementById("save-btn");
const connectBtn = document.getElementById("connect-btn");

function showMessage(text, type = "error") {
	messageBox.textContent = text;
	messageBox.className = `message visible ${type}`;
}

function hideMessage() {
	messageBox.textContent = "";
	messageBox.className = "message";
}

function setBusy(isBusy) {
	saveBtn.disabled = isBusy;
	connectBtn.disabled = isBusy;
	clientIdInput.disabled = isBusy;
	clientSecretInput.disabled = isBusy;
}

function getReturnPath() {
	const params = new URLSearchParams(window.location.search);
	const raw = params.get("return") || "/";
	if (!raw.startsWith("/")) {
		return "/";
	}
	return raw;
}

async function saveOAuthClient() {
	hideMessage();
	const clientId = clientIdInput.value.trim();
	const clientSecret = clientSecretInput.value.trim();

	if (!clientId || !clientSecret) {
		showMessage("Legg inn både client id og client secret før lagring.");
		return false;
	}

	setBusy(true);
	try {
		const response = await fetch("/api/oauth-client", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ clientId, clientSecret }),
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(body.error || "Kunne ikke lagre OAuth-nøkler.");
		}
		showMessage("Nøkler lagret for denne sesjonen.", "success");
		return true;
	} catch (error) {
		showMessage(error.message);
		return false;
	} finally {
		setBusy(false);
	}
}

saveBtn.addEventListener("click", async () => {
	await saveOAuthClient();
});

connectBtn.addEventListener("click", async () => {
	const saved = await saveOAuthClient();
	if (!saved) {
		return;
	}
	window.location.href = "/auth/login";
});

(async function bootstrap() {
	try {
		const response = await fetch("/api/status");
		const status = await response.json().catch(() => ({}));
		if (response.ok && status.authorized) {
			window.location.href = getReturnPath();
		}
	} catch {
		// Ignore status fetch failure on auth page.
	}
})();

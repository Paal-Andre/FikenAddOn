const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
const FIKEN_OAUTH_AUTHORIZE_URL = "https://fiken.no/oauth/authorize";
const FIKEN_OAUTH_TOKEN_URL = "https://fiken.no/oauth/token";

const CLIENT_ID = process.env.FIKEN_CLIENT_ID;
const CLIENT_SECRET = process.env.FIKEN_CLIENT_SECRET;
const REDIRECT_URI = "https://fikenaddon-cjfeb8bha4b5abfy.norwayeast-01.azurewebsites.net/auth/callback";
const COMPANY_SLUG_ENV = process.env.FIKEN_COMPANY_SLUG;
const ACCESS_TOKEN_ENV = process.env.FIKEN_ACCESS_TOKEN;

const TOKEN_FILE = path.join(__dirname, ".fiken-tokens.json");
const oauthStateStore = new Map();
const SESSION_COOKIE_NAME = "fiken_session";

app.use(express.json());
app.set("trust proxy", true);
app.use(express.static(path.join(__dirname, "public")));

function formatDate(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function addDays(date, amount) {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + amount);
	return copy;
}

function startOfWeekMonday(date) {
	const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const mondayOffset = (copy.getDay() + 6) % 7;
	copy.setDate(copy.getDate() - mondayOffset);
	return copy;
}

function getPeriodRanges(period) {
	const now = new Date();

	if (period === "year") {
		const currentStart = new Date(now.getFullYear(), 0, 1);
		const currentEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());

		const previousStart = new Date(now.getFullYear() - 1, 0, 1);
		const previousYearMonthLastDay = new Date(now.getFullYear() - 1, now.getMonth() + 1, 0).getDate();
		const previousYearDay = Math.min(now.getDate(), previousYearMonthLastDay);
		const previousEnd = new Date(now.getFullYear() - 1, now.getMonth(), previousYearDay);

		return {
			current: { start: formatDate(currentStart), end: formatDate(currentEnd) },
			previous: { start: formatDate(previousStart), end: formatDate(previousEnd) },
			labels: { current: "Inneværende år", previous: "Forrige år (samme periode)" },
		};
	}

	if (period === "month") {
		const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
		const currentEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

		const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
		const previousEnd = new Date(now.getFullYear(), now.getMonth(), 0);

		return {
			current: { start: formatDate(currentStart), end: formatDate(currentEnd) },
			previous: { start: formatDate(previousStart), end: formatDate(previousEnd) },
			labels: { current: "Inneværende måned", previous: "Forrige måned" },
		};
	}

	const currentStart = startOfWeekMonday(now);
	const currentEnd = addDays(currentStart, 6);

	const previousStart = addDays(currentStart, -7);
	const previousEnd = addDays(currentStart, -1);

	return {
		current: { start: formatDate(currentStart), end: formatDate(currentEnd) },
		previous: { start: formatDate(previousStart), end: formatDate(previousEnd) },
		labels: { current: "Inneværende uke", previous: "Forrige uke" },
	};
}

function encodeBasicAuth(clientId, clientSecret) {
	return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function readTokens() {
	try {
		const fileContent = await fs.readFile(TOKEN_FILE, "utf8");
		return JSON.parse(fileContent);
	} catch {
		return null;
	}
}

async function writeTokens(tokens) {
	await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

function parseCookies(req) {
	const raw = req.headers.cookie || "";
	const cookies = {};
	for (const part of raw.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) {
			continue;
		}
		const key = trimmed.slice(0, eqIndex).trim();
		const value = decodeURIComponent(trimmed.slice(eqIndex + 1).trim());
		cookies[key] = value;
	}
	return cookies;
}

function setSessionCookie(res, sessionId) {
	const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
	res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function getOrCreateSessionId(req, res) {
	const cookies = parseCookies(req);
	const existing = cookies[SESSION_COOKIE_NAME];
	if (existing) {
		return existing;
	}

	const created = crypto.randomUUID();
	setSessionCookie(res, created);
	return created;
}

async function readTokenStore() {
	const stored = await readTokens();
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
		return {};
	}
	return stored;
}

async function readSessionTokens(sessionId) {
	const store = await readTokenStore();
	return store[sessionId] || null;
}

async function writeSessionTokens(sessionId, tokenPayload) {
	const store = await readTokenStore();
	store[sessionId] = tokenPayload;
	await writeTokens(store);
}

async function deleteSessionTokens(sessionId) {
	const store = await readTokenStore();
	if (!store[sessionId]) {
		return;
	}
	delete store[sessionId];
	await writeTokens(store);
}

function isExpired(tokens) {
	if (!tokens || !tokens.accessToken || !tokens.receivedAt || !tokens.expiresIn) {
		return true;
	}

	const expiresAt = new Date(tokens.receivedAt).getTime() + Number(tokens.expiresIn) * 1000;
	const safeNow = Date.now() + 60 * 1000;
	return safeNow >= expiresAt;
}

async function refreshAccessToken(tokens) {
	const oauthClient = tokens?.oauthClient;
	if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
		throw new Error("Mangler OAuth client id/client secret for sesjonen. Registrer egne nøkler først.");
	}

	if (!tokens?.refreshToken) {
		throw new Error("Ingen refresh-token funnet. Logg inn pa nytt via /auth/login.");
	}

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: tokens.refreshToken,
	});

	const response = await axios.post(FIKEN_OAUTH_TOKEN_URL, body.toString(), {
		headers: {
			Authorization: `Basic ${encodeBasicAuth(oauthClient.clientId, oauthClient.clientSecret)}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		timeout: 15000,
	});

	const refreshed = {
		oauthClient,
		accessToken: response.data.access_token,
		refreshToken: response.data.refresh_token || tokens.refreshToken,
		expiresIn: response.data.expires_in,
		tokenType: response.data.token_type,
		receivedAt: new Date().toISOString(),
	};

	return refreshed;
}

async function getValidAccessToken(sessionId) {
	if (ACCESS_TOKEN_ENV) {
		return ACCESS_TOKEN_ENV;
	}

	if (!sessionId) {
		return null;
	}

	const tokens = await readSessionTokens(sessionId);
	if (!tokens) {
		return null;
	}

	if (!isExpired(tokens)) {
		return tokens.accessToken;
	}

	const refreshedTokens = await refreshAccessToken(tokens);
	await writeSessionTokens(sessionId, refreshedTokens);
	return refreshedTokens.accessToken;
}

async function fikenGet(apiPathWithQuery, accessToken) {
	const response = await axios.get(`${FIKEN_API_BASE}${apiPathWithQuery}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"X-Request-ID": crypto.randomUUID(),
			Accept: "application/json",
		},
		timeout: 20000,
	});

	return response.data;
}

async function fetchAllPaged(apiPath, accessToken, query = {}) {
	const pageSize = 100;
	let page = 0;
	const all = [];

	while (true) {
		const params = new URLSearchParams({
			...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
			page: String(page),
			pageSize: String(pageSize),
		});

		const pageData = await fikenGet(`${apiPath}?${params.toString()}`, accessToken);

		if (!Array.isArray(pageData) || pageData.length === 0) {
			break;
		}

		all.push(...pageData);

		if (pageData.length < pageSize) {
			break;
		}

		page += 1;
	}

	return all;
}

async function resolveCompanySlug(accessToken, requestedSlug) {
	if (requestedSlug) {
		return requestedSlug;
	}

	if (COMPANY_SLUG_ENV) {
		return COMPANY_SLUG_ENV;
	}

	const companies = await fikenGet("/companies", accessToken);
	const first = Array.isArray(companies) ? companies[0] : null;
	const fallback = first?.slug || first?.companySlug;

	if (!fallback) {
		throw new Error("Fant ingen foretak i Fiken-kontoen.");
	}

	return fallback;
}

function aggregateMetrics(entries) {
	const byUser = new Map();

	for (const entry of entries) {
		const user = entry.timeUser || {};
		const userId = String(user.timeUserId ?? entry.timeUserId ?? "ukjent");
		const name = user.name || `Ukjent bruker (${userId})`;
		const hours = Number(entry.hours || 0);
		const hourlyRateCents = Number(entry.activity?.hourlyRate || 0);
		const incomeNok = (hours * hourlyRateCents) / 100;

		const current = byUser.get(userId) || { userId, name, hours: 0, incomeNok: 0 };
		current.hours += hours;
		current.incomeNok += incomeNok;
		byUser.set(userId, current);
	}

	return byUser;
}

function getTrendConfig(period) {
	const now = new Date();

	if (period === "year") {
		const years = [];
		for (let year = now.getFullYear() - 4; year <= now.getFullYear(); year += 1) {
			years.push(year);
		}

		return {
			start: `${years[0]}-01-01`,
			end: `${years[years.length - 1]}-12-31`,
			labels: years.map(String),
			bucketKey: (dateValue) => String(new Date(dateValue).getFullYear()),
		};
	}

	if (period === "month") {
		const labels = [];
		const keys = [];
		for (let offset = 11; offset >= 0; offset -= 1) {
			const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
			const year = date.getFullYear();
			const month = date.getMonth() + 1;
			const key = `${year}-${String(month).padStart(2, "0")}`;
			keys.push(key);
			labels.push(date.toLocaleDateString("nb-NO", { month: "short", year: "2-digit" }));
		}

		const start = `${keys[0]}-01`;
		const lastDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
		const end = formatDate(lastDate);

		return {
			start,
			end,
			labels,
			keys,
			bucketKey: (dateValue) => {
				const date = new Date(dateValue);
				return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
			},
		};
	}

	const weekStarts = [];
	for (let offset = 11; offset >= 0; offset -= 1) {
		const start = addDays(startOfWeekMonday(now), -offset * 7);
		weekStarts.push(start);
	}

	const labels = weekStarts.map((start) => {
		const end = addDays(start, 6);
		return `${formatDate(start).slice(5)} - ${formatDate(end).slice(5)}`;
	});

	const keys = weekStarts.map((start) => formatDate(start));

	return {
		start: keys[0],
		end: formatDate(addDays(weekStarts[weekStarts.length - 1], 6)),
		labels,
		keys,
		bucketKey: (dateValue) => formatDate(startOfWeekMonday(new Date(dateValue))),
	};
}

function buildTrendSeries(entries, period, usersById, visibleUserIds) {
	const trendConfig = getTrendConfig(period);
	const keys = trendConfig.keys || trendConfig.labels;
	const keyToIndex = new Map(keys.map((key, index) => [key, index]));
	const dataByUser = new Map();

	for (const userId of visibleUserIds) {
		dataByUser.set(userId, new Array(keys.length).fill(0));
	}

	for (const entry of entries) {
		const user = entry.timeUser || {};
		const userId = String(user.timeUserId ?? entry.timeUserId ?? "ukjent");
		if (!dataByUser.has(userId)) {
			continue;
		}

		const bucket = trendConfig.bucketKey(entry.date);
		const index = keyToIndex.get(bucket);
		if (index === undefined) {
			continue;
		}

		const hourlyRateCents = Number(entry.activity?.hourlyRate || 0);
		const incomeNok = (Number(entry.hours || 0) * hourlyRateCents) / 100;
		dataByUser.get(userId)[index] += incomeNok;
	}

	const series = [...visibleUserIds].map((userId) => {
		const user = usersById.get(userId);
		const name = user?.name || `Ukjent bruker (${userId})`;
		const values = (dataByUser.get(userId) || []).map((value) => Number(value.toFixed(2)));
		return { userId, name, values };
	});

	return {
		labels: trendConfig.labels,
		series,
		metric: "incomeNok",
	};
}

async function buildSummary(period, requestedCompanySlug, sessionId) {
	const accessToken = await getValidAccessToken(sessionId);
	if (!accessToken) {
		return { unauthorized: true };
	}

	const companySlug = await resolveCompanySlug(accessToken, requestedCompanySlug);
	const ranges = getPeriodRanges(period);

	const timeUsers = await fetchAllPaged(`/companies/${companySlug}/timeUsers`, accessToken);

	const currentEntries = await fetchAllPaged(`/companies/${companySlug}/timeEntries`, accessToken, {
		dateGe: ranges.current.start,
		dateLe: ranges.current.end,
	});

	const previousEntries = await fetchAllPaged(`/companies/${companySlug}/timeEntries`, accessToken, {
		dateGe: ranges.previous.start,
		dateLe: ranges.previous.end,
	});

	const trendConfig = getTrendConfig(period);
	const trendEntries = await fetchAllPaged(`/companies/${companySlug}/timeEntries`, accessToken, {
		dateGe: trendConfig.start,
		dateLe: trendConfig.end,
	});

	const usersById = new Map(
		(timeUsers || []).map((user) => [String(user.timeUserId), { userId: String(user.timeUserId), name: user.name || "Ukjent" }])
	);

	const currentByUser = aggregateMetrics(currentEntries);
	const previousByUser = aggregateMetrics(previousEntries);

	const allUserIds = new Set([...usersById.keys(), ...currentByUser.keys(), ...previousByUser.keys()]);

	const consultants = [...allUserIds]
		.map((userId) => {
			const knownUser = usersById.get(userId);
			const current = currentByUser.get(userId)?.hours || 0;
			const previous = previousByUser.get(userId)?.hours || 0;
			const currentIncomeNok = currentByUser.get(userId)?.incomeNok || 0;
			const previousIncomeNok = previousByUser.get(userId)?.incomeNok || 0;
			const fallbackName = currentByUser.get(userId)?.name || previousByUser.get(userId)?.name || `Ukjent bruker (${userId})`;

			return {
				userId,
				name: knownUser?.name || fallbackName,
				currentHours: Number(current.toFixed(2)),
				previousHours: Number(previous.toFixed(2)),
				currentIncomeNok: Number(currentIncomeNok.toFixed(2)),
				previousIncomeNok: Number(previousIncomeNok.toFixed(2)),
			};
		})
		.filter((item) => item.currentHours > 0 || item.currentIncomeNok > 0 || item.previousHours > 0 || item.previousIncomeNok > 0)
		.sort((a, b) => a.name.localeCompare(b.name, "no"));

	const totalCurrent = Number(consultants.reduce((sum, item) => sum + item.currentHours, 0).toFixed(2));
	const totalPrevious = Number(consultants.reduce((sum, item) => sum + item.previousHours, 0).toFixed(2));
	const totalCurrentIncomeNok = Number(consultants.reduce((sum, item) => sum + item.currentIncomeNok, 0).toFixed(2));
	const totalPreviousIncomeNok = Number(consultants.reduce((sum, item) => sum + item.previousIncomeNok, 0).toFixed(2));
	const visibleUserIds = consultants.map((consultant) => consultant.userId);
	const trend = buildTrendSeries(trendEntries, period, usersById, visibleUserIds);

	return {
		unauthorized: false,
		period,
		labels: ranges.labels,
		ranges,
		companySlug,
		consultants,
		trend,
		totals: {
			currentHours: totalCurrent,
			previousHours: totalPrevious,
			currentIncomeNok: totalCurrentIncomeNok,
			previousIncomeNok: totalPreviousIncomeNok,
		},
	};
}

app.get("/auth/login", async (req, res) => {
	const sessionId = getOrCreateSessionId(req, res);
	const sessionData = await readSessionTokens(sessionId);
	const oauthClient = sessionData?.oauthClient;

	if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
		res.status(400).send("Mangler egne Fiken OAuth-nokler i sesjonen. Legg inn client id/secret i appen forst.");
		return;
	}

	const state = crypto.randomUUID();
	oauthStateStore.set(state, {
		createdAt: Date.now(),
		sessionId,
	});

	const params = new URLSearchParams({
		response_type: "code",
		client_id: oauthClient.clientId,
		redirect_uri: REDIRECT_URI,
		state,
	});

	res.redirect(`${FIKEN_OAUTH_AUTHORIZE_URL}?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
	const { code, state, error, error_description: errorDescription } = req.query;

	if (error) {
		res.status(400).send(`OAuth-feil: ${errorDescription || error}`);
		return;
	}

	if (!code || !state || !oauthStateStore.has(state)) {
		res.status(400).send("Ugyldig OAuth callback. Mangler code/state.");
		return;
	}

	const stateInfo = oauthStateStore.get(state);
	oauthStateStore.delete(state);
	const sessionId = stateInfo?.sessionId;
	if (!sessionId) {
		res.status(400).send("Ugyldig OAuth state/session.");
		return;
	}
	setSessionCookie(res, sessionId);

	const existingSessionData = await readSessionTokens(sessionId);
	const oauthClient = existingSessionData?.oauthClient;
	if (!oauthClient?.clientId || !oauthClient?.clientSecret) {
		res.status(400).send("Mangler OAuth client id/client secret i sesjonen.");
		return;
	}

	try {
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code: String(code),
			redirect_uri: REDIRECT_URI,
			state: String(state),
		});

		const response = await axios.post(FIKEN_OAUTH_TOKEN_URL, body.toString(), {
			headers: {
				Authorization: `Basic ${encodeBasicAuth(oauthClient.clientId, oauthClient.clientSecret)}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			timeout: 15000,
		});

		const tokenPayload = {
			oauthClient,
			accessToken: response.data.access_token,
			refreshToken: response.data.refresh_token,
			expiresIn: response.data.expires_in,
			tokenType: response.data.token_type,
			receivedAt: new Date().toISOString(),
		};

		await writeSessionTokens(sessionId, tokenPayload);
		res.redirect("/");
	} catch (err) {
		res.status(500).send(`Kunne ikke hente access token: ${err.response?.data?.error_description || err.message}`);
	}
});

app.get("/auth/logout", async (req, res) => {
	const sessionId = parseCookies(req)[SESSION_COOKIE_NAME];
	if (sessionId) {
		await deleteSessionTokens(sessionId);
	}
	res.redirect("/");
});

app.post("/api/oauth-client", async (req, res) => {
	const sessionId = getOrCreateSessionId(req, res);
	const clientId = String(req.body?.clientId || "").trim();
	const clientSecret = String(req.body?.clientSecret || "").trim();

	if (!clientId || !clientSecret) {
		res.status(400).json({ error: "Mangler clientId eller clientSecret." });
		return;
	}

	const existing = (await readSessionTokens(sessionId)) || {};
	await writeSessionTokens(sessionId, {
		...existing,
		oauthClient: {
			clientId,
			clientSecret,
		},
	});

	res.json({ ok: true });
});

app.get("/api/status", async (req, res) => {
	const sessionId = getOrCreateSessionId(req, res);
	const sessionData = await readSessionTokens(sessionId);
	const accessToken = await getValidAccessToken(sessionId);
	res.json({
		authorized: Boolean(accessToken),
		hasConfiguredOAuthClient: Boolean(sessionData?.oauthClient?.clientId && sessionData?.oauthClient?.clientSecret),
		companySlug: COMPANY_SLUG_ENV || null,
	});
});

app.get("/api/companies", async (req, res) => {
	try {
		const sessionId = getOrCreateSessionId(req, res);
		const accessToken = await getValidAccessToken(sessionId);
		if (!accessToken) {
			res.status(401).json({ error: "Ikke autentisert. Gå til /auth/login først." });
			return;
		}

		const companies = await fikenGet("/companies", accessToken);
		res.json(companies || []);
	} catch (err) {
		res.status(err.response?.status || 500).json({
			error: "Kunne ikke hente foretak fra Fiken.",
			details: err.response?.data || err.message,
		});
	}
});

app.get("/api/summary", async (req, res) => {
	const requestedPeriod = String(req.query.period || "week");
	const period = ["week", "month", "year"].includes(requestedPeriod) ? requestedPeriod : "week";
	const companySlug = req.query.companySlug ? String(req.query.companySlug) : undefined;
	const sessionId = getOrCreateSessionId(req, res);

	try {
		const summary = await buildSummary(period, companySlug, sessionId);

		if (summary.unauthorized) {
			res.status(401).json({
				error: "Ikke autentisert mot Fiken. Gå til /auth/login først.",
			});
			return;
		}

		res.json(summary);
	} catch (err) {
		res.status(err.response?.status || 500).json({
			error: "Klarte ikke å hente timer fra Fiken.",
			details: err.response?.data || err.message,
		});
	}
});

app.listen(PORT, () => {
	console.log(`Fiken Time App kjører på http://localhost:${PORT}`);
});

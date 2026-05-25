const companySelect = document.getElementById("company-select");
const refreshBtn = document.getElementById("refresh-btn");
const cardsContainer = document.getElementById("cards");
const messageBox = document.getElementById("message");
const periodLabel = document.getElementById("period-label");
const rangeLabel = document.getElementById("range-label");
const previousLabel = document.getElementById("previous-label");
const totalCurrent = document.getElementById("total-current");
const totalPrevious = document.getElementById("total-previous");
const loadingBox = document.getElementById("loading");
const trendChartCanvas = document.getElementById("trend-chart");
const chartSubtitle = document.getElementById("chart-subtitle");
const consultantTemplate = document.getElementById("consultant-template");
const loginLink = document.getElementById("login-link");
const logoutLink = document.getElementById("logout-link");
const periodButtons = [...document.querySelectorAll(".segment-button")];

let selectedPeriod = "week";
let hasCompaniesLoaded = false;
let trendChart = null;

function showMessage(text, type = "error") {
	messageBox.textContent = text;
	messageBox.className = `message visible ${type}`;
}

function hideMessage() {
	messageBox.textContent = "";
	messageBox.className = "message";
}

function dateText(value) {
	const date = new Date(value);
	return date.toLocaleDateString("nb-NO");
}

function formatCurrencyNok(value) {
	return new Intl.NumberFormat("nb-NO", {
		style: "currency",
		currency: "NOK",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(Number(value || 0));
}

function formatCompactCurrencyNok(value) {
	return new Intl.NumberFormat("nb-NO", {
		style: "currency",
		currency: "NOK",
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(Number(value || 0));
}

function stringToColor(input) {
	let hash = 0;
	for (let i = 0; i < input.length; i += 1) {
		hash = input.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return {
		line: `hsl(${hue}, 70%, 45%)`,
		fill: `hsla(${hue}, 70%, 45%, 0.12)`,
	};
}

function setAuthUi(authorized) {
	loginLink.style.display = authorized ? "none" : "inline-flex";
	logoutLink.style.display = authorized ? "inline-flex" : "none";
}

function setLoading(isLoading) {
	loadingBox.className = isLoading ? "loading visible" : "loading";
	refreshBtn.disabled = isLoading;
	companySelect.disabled = isLoading;
	periodButtons.forEach((button) => {
		button.disabled = isLoading;
	});
}

async function fetchJson(url) {
	const response = await fetch(url);
	const body = await response.json().catch(() => ({}));

	if (!response.ok) {
		const details = body.details ? ` (${JSON.stringify(body.details)})` : "";
		throw new Error(body.error || `Feil ved kall mot ${url}${details}`);
	}

	return body;
}

function renderCards(summary) {
	cardsContainer.innerHTML = "";

	summary.consultants.forEach((consultant, index) => {
		const node = consultantTemplate.content.cloneNode(true);
		node.querySelector(".consultant-name").textContent = consultant.name;
		node.querySelector(".current-income").textContent = formatCurrencyNok(consultant.currentIncomeNok);
		node.querySelector(".previous-income").textContent = formatCurrencyNok(consultant.previousIncomeNok);
		node.querySelector(".previous-label-item").textContent = summary.labels.previous;

		const card = node.querySelector(".consultant-card");
		card.style.animationDelay = `${index * 35}ms`;

		cardsContainer.appendChild(node);
	});
}

function renderSummary(summary) {
	periodLabel.textContent = summary.labels.current;
	previousLabel.textContent = summary.labels.previous;
	rangeLabel.textContent = `${dateText(summary.ranges.current.start)} - ${dateText(summary.ranges.current.end)}`;
	totalCurrent.textContent = formatCurrencyNok(summary.totals.currentIncomeNok);
	totalPrevious.textContent = formatCurrencyNok(summary.totals.previousIncomeNok);
	renderTrendChart(summary.trend, summary.labels.current);
	renderCards(summary);
}

function renderTrendChart(trend, periodLabelText) {
	if (!trendChartCanvas || typeof Chart === "undefined") {
		return;
	}

	if (!trend || !Array.isArray(trend.labels) || !Array.isArray(trend.series)) {
		return;
	}

	chartSubtitle.textContent = `${periodLabelText}: ${trend.labels[0]} til ${trend.labels[trend.labels.length - 1]}`;

	const datasets = trend.series.map((item) => {
		const color = stringToColor(item.userId);
		return {
			label: item.name,
			data: item.values,
			borderColor: color.line,
			backgroundColor: color.fill,
			borderWidth: 2,
			tension: 0.3,
			pointRadius: 2,
			pointHoverRadius: 4,
			fill: false,
		};
	});

	if (trendChart) {
		trendChart.destroy();
	}

	trendChart = new Chart(trendChartCanvas, {
		type: "line",
		data: {
			labels: trend.labels,
			datasets,
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: {
				mode: "nearest",
				intersect: false,
			},
			plugins: {
				legend: {
					position: "bottom",
					labels: {
						boxWidth: 12,
						usePointStyle: true,
					},
				},
				tooltip: {
					callbacks: {
						label(context) {
							return `${context.dataset.label}: ${formatCurrencyNok(context.parsed.y)}`;
						},
					},
				},
			},
			scales: {
				y: {
					beginAtZero: true,
					ticks: {
						callback(value) {
							return formatCompactCurrencyNok(value);
						},
					},
				},
			},
		},
	});
}

async function ensureCompanies() {
	if (hasCompaniesLoaded) {
		return;
	}

	const companies = await fetchJson("/api/companies");
	companySelect.innerHTML = "";

	companies.forEach((company) => {
		const option = document.createElement("option");
		option.value = company.slug || company.companySlug;
		option.textContent = `${company.name || option.value} (${option.value})`;
		companySelect.appendChild(option);
	});

	hasCompaniesLoaded = true;
}

async function loadSummary() {
	hideMessage();
	setLoading(true);

	try {
		const companySlug = companySelect.value;
		const query = new URLSearchParams({
			period: selectedPeriod,
			...(companySlug ? { companySlug } : {}),
		});

		const summary = await fetchJson(`/api/summary?${query.toString()}`);
		renderSummary(summary);
	} catch (error) {
		showMessage(error.message);
	} finally {
		setLoading(false);
	}
}

async function bootstrap() {
	try {
		const status = await fetchJson("/api/status");
		setAuthUi(status.authorized);

		if (!status.authorized) {
			showMessage("Ikke autentisert mot Fiken. Trykk Koble til Fiken for å logge inn.");
			return;
		}

		await ensureCompanies();
		await loadSummary();
	} catch (error) {
		showMessage(error.message);
	}
}

periodButtons.forEach((button) => {
	button.addEventListener("click", () => {
		periodButtons.forEach((item) => item.classList.remove("is-active"));
		button.classList.add("is-active");
		selectedPeriod = button.dataset.period;
		loadSummary();
	});
});

companySelect.addEventListener("change", () => {
	loadSummary();
});

refreshBtn.addEventListener("click", () => {
	loadSummary();
});

bootstrap();

const state = {
  data: null,
  config: null,
  runtimeAdapters: {},
  expandedDay: null,
  countdownTimer: null,
  purchasedTickets: new Set(),
  todos: []
};

const MODULE_NAMES = Object.freeze(["flights", "overview", "itinerary", "todo", "driving", "ledger"]);
const SHARED_COLLECTIONS = Object.freeze(["todos", "tickets", "ledger"]);

function normalizeTripConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== "1.0.0") throw new Error("trip-data.json config.schemaVersion must be 1.0.0");
  if (!raw.modules || typeof raw.modules !== "object") throw new Error("trip-data.json config must contain confirmed module switches");
  const modules = Object.fromEntries(MODULE_NAMES.map((name) => {
    if (typeof raw.modules[name] !== "boolean") throw new Error(`trip-data.json config.modules.${name} must be boolean`);
    return [name, raw.modules[name]];
  }));
  const mode = raw?.persistence?.mode;
  if (mode !== "local" && mode !== "d1") throw new Error("trip-data.json config.persistence.mode must be local or d1");
  const sharedCollections = mode === "d1" ? [...new Set(raw.persistence.sharedCollections || [])] : [];
  if (mode === "d1" && (!sharedCollections.length || sharedCollections.some((name) => !SHARED_COLLECTIONS.includes(name)))) {
    throw new Error("D1 mode requires an explicit sharedCollections allowlist");
  }
  const apiBase = raw.persistence.apiBase || "/api/trip";
  if (mode === "d1" && (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase))) {
    throw new Error("D1 apiBase must be a same-origin path");
  }
  return {
    ...raw,
    modules,
    persistence: {
      ...(raw.persistence || {}),
      mode,
      ...(mode === "d1" ? { apiBase, sharedCollections } : {})
    }
  };
}

function moduleEnabled(name) {
  return Boolean(state.config && state.config.modules?.[name] === true);
}

function applyModuleConfig() {
  document.querySelectorAll("[data-module]").forEach((element) => {
    element.hidden = !moduleEnabled(element.dataset.module);
  });
  const visibleTravelLinks = [...document.querySelectorAll(".travel-navigation-menu [data-module]")].filter((link) => !link.hidden);
  const travelNavigation = $("#travel-navigation");
  if (travelNavigation) travelNavigation.hidden = visibleTravelLinks.length === 0;
  document.documentElement.dataset.persistence = state.config.persistence.mode;

  const hashModules = {
    "#flights": "flights", "#route": "overview", "#itinerary": "itinerary",
    "#drive": "driving", "#prep": "todo", "#ledger": "ledger", "#ledger-stats": "ledger"
  };
  const requestedModule = hashModules[location.hash];
  if (requestedModule && !moduleEnabled(requestedModule)) {
    const firstVisible = visibleTravelLinks[0]?.getAttribute("href") || "#top";
    history.replaceState({ view: "travel" }, "", firstVisible);
  }
  window.dispatchEvent(new CustomEvent("travel-config:ready", { detail: { config: state.config } }));
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

const airportCity = (airport) => airport.city || airport.airportCode;

function localDateTime(date, time, _airportCode, utcOffset = "") {
  return new Date(`${date}T${time}:00${utcOffset || "+00:00"}`);
}

function countdownParts(target, now = new Date()) {
  const difference = target.getTime() - now.getTime();
  if (difference <= 0) return { difference, days: 0, hours: 0, minutes: 0 };
  const totalMinutes = Math.floor(difference / 60000);
  return {
    difference,
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60
  };
}

function countdownText(target, completionText = "Departed") {
  const value = countdownParts(target);
  if (value.difference <= 0) return completionText;
  if (value.days > 0) return `${value.days} days ${String(value.hours).padStart(2, "0")}h`;
  if (value.hours > 0) return `${value.hours}h ${String(value.minutes).padStart(2, "0")}min`;
  return `${Math.max(1, value.minutes)}min`;
}

function preciseCountdownText(target, completionText = "Departed") {
  const difference = target.getTime() - Date.now();
  if (difference <= 0) return completionText;
  const totalSeconds = Math.floor(difference / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `${days} days ${clock}` : clock;
}

function formatDate(dateString, includeYear = false) {
  const date = new Date(`${dateString}T12:00:00`);
  const options = includeYear
    ? { year: "numeric", month: "long", day: "numeric" }
    : { month: "long", day: "numeric" };
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

function formatCompactDate(dateString) {
  return new Intl.DateTimeFormat("en-US", {month:"short", day:"numeric"}).format(new Date(`${dateString}T12:00:00`));
}

function todayForTrip() {
  const timeZone = state.data?.metadata?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
}

function mapsSearch(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function heroDestinationFor(trip) {
  const destinations = (trip.countries || []).filter((country) => (trip.primaryDestinationCountries || []).includes(country.code));
  const isDomestic = destinations.length > 0 && destinations.every((country) => country.code === "CN");
  const customTitle = String(trip.heroTitle || "").trim();
  if (customTitle) {
    return { title: customTitle, eyebrow: String(trip.heroEyebrow || "").trim(), destinations, isDomestic };
  }
  if (isDomestic) {
    const destination = String(trip.primaryDestinationName || trip.primaryDestinationCity || trip.citiesAndAreas?.[0] || "Destination to confirm").trim();
    return {
      title: destination,
      eyebrow: String(trip.primaryDestinationNameEn || trip.primaryDestinationCityEn || "DOMESTIC JOURNEY").trim(),
      destinations,
      isDomestic
    };
  }
  return {
    title: destinations.map((country) => country.nameZh || country.name).join(" × ") || "Destination to confirm",
    eyebrow: destinations.map((country) => country.nameEn || country.name).filter(Boolean).join(" × "),
    destinations,
    isDomestic
  };
}

function renderHero() {
  const { trip } = state.data;
  if (trip.status === "uninitialized") {
    document.title = state.data.metadata.title;
    $("#trip-title").textContent = "Trip awaiting details";
    $("#trip-eyebrow").textContent = "READY FOR YOUR JOURNEY";
    $("#wordmark").innerHTML = "TRIP <span>· READY</span>";
    $("#footer-mark").textContent = "TRIP · READY";
    $("#route-day-count").textContent = "0 DAYS";
    $("#trip-date").textContent = "Awaiting trip details";
    return;
  }
  const hero = heroDestinationFor(trip);
  const { destinations } = hero;
  const shortMark = destinations.map((country) => country.code).join(" / ");
  const year = trip.startDate.slice(0, 4);
  document.title = state.data.metadata.title;
  $("#trip-title").textContent = hero.title;
  $("#trip-eyebrow").textContent = hero.eyebrow;
  $("#wordmark").innerHTML = `${escapeHtml(shortMark)} <span>· ${escapeHtml(year)}</span>`;
  $("#footer-mark").textContent = `${shortMark} · ${year}`;
  $("#route-day-count").textContent = `${trip.dayCount} DAYS`;
  $("#trip-date").textContent = `${formatCompactDate(trip.startDate)} — ${formatCompactDate(trip.endDate)} · ${trip.dayCount} days`;
}

function journeyFlights(journeyId) {
  return state.data.flights
    .filter((flight) => flight.journeyId === journeyId)
    .sort((first, second) => first.sequence - second.sequence);
}

function journeyStatusAndTarget(flights) {
  const now = new Date();
  for (const flight of flights) {
    const departure = localDateTime(flight.departure.date, flight.departure.time, flight.departure.airportCode, flight.departure.utcOffset);
    const arrival = localDateTime(flight.arrival.date, flight.arrival.time, flight.arrival.airportCode, flight.arrival.utcOffset);
    if (now < departure) return { target: departure, label: flight === flights[0] ? "Until proposed departure" : "Until next proposed flight", complete: false };
    if (now < arrival) return { target: arrival, label: "In flight · Until arrival", complete: false };
  }
  return { target: null, label: "Arrived", complete: true };
}

function relativeFlightDate(date, journeyStartDate) {
  if (date === journeyStartDate) return formatCompactDate(date);
  const difference = Math.round((new Date(`${date}T12:00:00`) - new Date(`${journeyStartDate}T12:00:00`)) / 86400000);
  return difference === 1 ? "Next day" : formatCompactDate(date);
}

function flightStopMarkup(stop, position, journeyStartDate) {
  let timing;
  if (position === 0) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.departure.date, journeyStartDate))}</span><b>${escapeHtml(stop.departure.time)} Departure</b>`;
  } else if (position === stop.totalStops - 1) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.arrival.date, journeyStartDate))}</span><b>${escapeHtml(stop.arrival.time)} Arrival</b>`;
  } else {
    const nextFlight = stop.nextFlight;
    const connection = nextFlight.connectionFromPrevious || {};
    const duration = connection.calculatedFromSchedule || connection.durationUsingTicketTimes || connection.plannedDurationText || "Connection";
    timing = `
      <span>${escapeHtml(stop.arrival.time)} Arrival</span>
      <em>${escapeHtml(duration)}</em>
      <b>${escapeHtml(relativeFlightDate(nextFlight.departure.date, journeyStartDate))} ${escapeHtml(nextFlight.departure.time)}</b>
      <span>Departure</span>
    `;
  }
  return `
    <div class="flight-stop${position > 0 && position < stop.totalStops - 1 ? " is-transfer" : ""}">
      <span class="flight-stop__code">${escapeHtml(stop.airport.airportCode)}</span>
      <span class="flight-stop__city">${escapeHtml(airportCity(stop.airport))}</span>
      <span class="flight-stop__dot" aria-hidden="true"></span>
      <div class="flight-stop__timing">${timing}</div>
    </div>
  `;
}

function flightMissingFieldLabel(field) {
  return ({
    carrierId: "Airline",
    flightNumber: "Flight number",
    departure: "Departure details",
    arrival: "Arrival details",
    departurePlace: "Departure airport",
    arrivalPlace: "Arrival airport",
    departureTime: "Departure time",
    arrivalTime: "Arrival time",
    timeZone: "Local time zone"
  })[field] || String(field || "Details to confirm");
}

function flightPlaceholderCard(journey, index) {
  const missingFields = [...new Set(journey.missingFields || [])].map(flightMissingFieldLabel);
  return `
    <article class="flight-card flight-card--placeholder" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-placeholder">
        <span class="flight-placeholder__eyebrow">Details to confirm</span>
        <h3>${escapeHtml(journey.title || "Flight details to confirm")}</h3>
        <p>This draft includes the available trip information; Missing flight details remain unconfirmed. </p>
        ${missingFields.length ? `<ul>${missingFields.map((field) => `<li>${escapeHtml(field)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}" data-placeholder="true">
          <span>Status</span>
          <strong>To confirm</strong>
        </div>
      </div>
    </article>
  `;
}

function flightCard(journey, index) {
  const flights = journeyFlights(journey.id);
  if (journey.placeholder || journey.status === "missing" || journey.status === "pending" || !flights.length || flights.some((flight) => flight.placeholder)) {
    return flightPlaceholderCard(journey, index);
  }
  const first = flights[0];
  const last = flights[flights.length - 1];
  const status = journeyStatusAndTarget(flights);
  const countdown = status.complete ? "Completed" : preciseCountdownText(status.target, "Departing soon");
  const stops = [
    { airport: first.departure, departure: first.departure },
    ...flights.map((flight, flightIndex) => ({
      airport: flight.arrival,
      arrival: flight.arrival,
      nextFlight: flights[flightIndex + 1]
    }))
  ];
  const routeItems = [];
  stops.forEach((stop, stopIndex) => {
    routeItems.push(flightStopMarkup({ ...stop, totalStops: stops.length }, stopIndex, first.departure.date));
    if (stopIndex < flights.length) {
      const flight = flights[stopIndex];
      routeItems.push(`
        <div class="flight-segment">
          <span>${escapeHtml(flight.flightNumber)}</span>
          <i aria-hidden="true">→</i>
        </div>
      `);
    }
  });
  return `
    <article class="flight-card" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-card__airlines">${escapeHtml([...new Set(flights.map((flight) => flight.airline.nameZh || flight.airline.name))].join(" · "))}</div>
      <div class="flight-flow" style="--route-columns: ${stops.map((_, stopIndex) => stopIndex < stops.length - 1 ? "minmax(0,1fr) minmax(34px,.5fr)" : "minmax(0,1fr)").join(" ")}">
        ${routeItems.join("")}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}">
          <span>${escapeHtml(status.label)}</span>
          <strong>${escapeHtml(countdown)}</strong>
        </div>
      </div>
    </article>
  `;
}

function renderFlights() {
  const journeys = state.data.flightJourneys;
  $("#flight-carousel").innerHTML = journeys.map(flightCard).join("");
  $("#flight-dots").innerHTML = journeys.map((_, index) => `<span class="carousel-dot${index === 0 ? " is-active" : ""}"></span>`).join("");
  $("#flight-index").textContent = `1 / ${journeys.length}`;

  const carousel = $("#flight-carousel");
  let scheduled = false;
  carousel.addEventListener("scroll", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const cards = $$(".flight-card", carousel);
      const center = carousel.scrollLeft + carousel.clientWidth / 2;
      let activeIndex = 0;
      let distance = Infinity;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        if (Math.abs(cardCenter - center) < distance) {
          distance = Math.abs(cardCenter - center);
          activeIndex = index;
        }
      });
      $$(".carousel-dot", $("#flight-dots")).forEach((dot, index) => dot.classList.toggle("is-active", index === activeIndex));
      $("#flight-index").textContent = `${activeIndex + 1} / ${journeys.length}`;
      scheduled = false;
    });
  }, { passive: true });
}

function updateFlightCountdowns() {
  state.data.flightJourneys.forEach((journey) => {
    const target = $(`[data-countdown-journey="${journey.id}"]`);
    if (!target || target.dataset.placeholder === "true" || journey.placeholder) return;
    const status = journeyStatusAndTarget(journeyFlights(journey.id));
    $("strong", target).textContent = status.complete ? "Completed" : preciseCountdownText(status.target, "Departing soon");
    $("span", target).textContent = status.label;
  });
}

function costText(cost) {
  if (cost.amount !== undefined) return `${cost.item} · ${cost.currency} ${cost.amount}`;
  if (cost.standard !== undefined && cost.standard !== null) return `${cost.item} · ${cost.currency} ${cost.standard}`;
  if (cost.discounted !== undefined && cost.discounted !== null) return `${cost.item} · ${cost.currency} ${cost.discounted}`;
  if (cost.amountOptions) return `${cost.item} · ${cost.currency} ${cost.amountOptions.join(" / ")}`;
  return cost.item;
}

function ticketsForDay(day) {
  if (!moduleEnabled("itinerary")) return [];
  return (state.data.ticketPlanning?.items || []).filter((ticket) =>
    ticket.dayId ? ticket.dayId === day.id : ticket.day === day.day
  );
}

function ticketsForSchedule(day, item) {
  if (!moduleEnabled("itinerary")) return [];
  const tickets = ticketsForDay(day);
  if (Array.isArray(item.ticketIds)) return tickets.filter((ticket) => item.ticketIds.includes(ticket.id));
  if (item.id) {
    const explicit = tickets.filter((ticket) => (ticket.scheduleItemIds || ticket.itemIds || []).includes(item.id));
    if (explicit.length) return explicit;
  }
  const lowerText = String(item.text || item.title || "").toLocaleLowerCase();
  return tickets.filter((ticket) => (ticket.scheduleMatchTerms || []).some((term) => lowerText.includes(term.toLocaleLowerCase())));
}

function isTicketPurchased(ticket) {
  return ticket.purchaseStatus === "purchased" || state.purchasedTickets.has(ticket.id);
}

function ticketRequirement(ticket) {
  return ({
    "advance-required": "Advance booking needed",
    "advance-recommended": "Reservation recommended",
    "needs-confirmation": "Details / check before travel"
  })[ticket.requirement] || "Visit information";
}

function ticketTitle(ticket) {
  return ticket.name || ticket.attraction?.nameZh || ticket.attraction?.name || "Booking details";
}

function ticketGuidance(ticket) {
  const guidance = ticket.guidance || ticket.notes || [];
  return Array.isArray(guidance) ? guidance.join(" · ") : String(guidance || "");
}

function ticketDocument(ticket) {
  const document = ticket.document || ticket.booking?.document;
  if (document && typeof document === "object") {
    return { url: document.url || document.path || "", type: document.type || "", label: document.label || "View document" };
  }
  const url = ticket.documentUrl || ticket.booking?.documentUrl || "";
  return url ? { url, type: "", label: ticket.documentLabel || "View document" } : null;
}

function inlineTicketMarkup(ticket) {
  const purchased = isTicketPurchased(ticket);
  const title = ticketTitle(ticket);
  return `
    <div class="schedule-ticket ${purchased ? "is-purchased" : `is-${escapeHtml(ticket.requirement)}`}" data-inline-ticket="${escapeHtml(ticket.id)}">
      <label class="schedule-ticket__toggle">
        <input type="checkbox" value="${escapeHtml(ticket.id)}" ${purchased ? "checked" : ""} aria-label="${purchased ? "Mark unchecked" : "Mark reviewed / arranged"}: ${escapeHtml(title)}">
        <span class="schedule-ticket__check" aria-hidden="true">✓</span>
        <span class="schedule-ticket__content">
          <span class="schedule-ticket__status">${purchased ? "Reviewed / arranged" : escapeHtml(ticketRequirement(ticket))}</span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(ticketGuidance(ticket))}</small>
        </span>
      </label>
      <button type="button" class="schedule-ticket__open" data-ticket-open="${escapeHtml(ticket.id)}" aria-haspopup="dialog" aria-controls="ticket-dialog">View</button>
    </div>`;
}

function dayCard(day) {
  const today = todayForTrip();
  const isToday = day.date === today;
  const expanded = state.expandedDay === day.day;
  const schedule = day.schedule.map((item) => {
    const destinations = navigationDestinations(item);
    const mapLinks = destinations.map((destination) => `
      <button type="button" class="schedule-map-link" data-map-query="${escapeHtml(destination.query)}" data-map-url="${escapeHtml(destination.url || "")}" data-map-label="${escapeHtml(destination.label)}" aria-haspopup="dialog" aria-controls="place-map" aria-label="View ${escapeHtml(destination.label)}  map">📍 ${escapeHtml(destination.label)}</button>
    `).join("");
    const scheduleTickets = ticketsForSchedule(day, item).map(inlineTicketMarkup).join("");
    return `
      <li class="schedule-item">
        <span class="schedule-time">${escapeHtml(item.time)}</span>
        <div class="schedule-content">
          <div class="schedule-text">${escapeHtml(item.text)}</div>
          ${scheduleTickets}
          ${mapLinks ? `<div class="schedule-map-links">${mapLinks}</div>` : ""}
        </div>
      </li>
    `;
  }).join("");
  const notes = [...(day.notes || []), ...(day.sourceDateLabelConflict ? [day.sourceDateLabelConflict] : [])];
  const costs = (day.costReferences || []).map((cost) => `<span class="cost-tag">${escapeHtml(costText(cost))}</span>`).join("");
  const dayTickets = ticketsForDay(day);
  const pendingTicketCount = dayTickets.filter((ticket) => !isTicketPurchased(ticket)).length;
  const ticketSummary = dayTickets.length
    ? `<span class="day-ticket-summary ${pendingTicketCount ? "has-pending" : "is-complete"}">${pendingTicketCount ? `${pendingTicketCount} items to check` : "Bookings checked"}</span>`
    : "";
  return `
    <article class="day-card${isToday ? " is-today" : ""}" data-day="${day.day}">
      <span class="day-dot" aria-hidden="true"></span>
      <button class="day-toggle" type="button" aria-expanded="${expanded}" aria-controls="day-detail-${day.day}">
        <span>
          <span class="day-meta">DAY ${String(day.day).padStart(2, "0")} · ${escapeHtml(formatCompactDate(day.date))}${isToday ? " · Today" : ""}</span>
          <span class="day-title">${escapeHtml(day.title)}</span>
          <span class="day-locations">${escapeHtml(day.locations.join(" → "))}</span>
          ${ticketSummary}
        </span>
        <span class="day-chevron" aria-hidden="true">+</span>
      </button>
      <div class="day-detail" id="day-detail-${day.day}" ${expanded ? "" : "hidden"}>
        <ol class="schedule">${schedule}</ol>
        ${costs ? `<div class="costs">${costs}</div>` : ""}
        ${notes.map((note) => `<p class="detail-note">${escapeHtml(note)}</p>`).join("")}
      </div>
    </article>
  `;
}

function navigationDestinations(item) {
  const policy = state.data.mapLinks?.navigationPolicy || { noNavigationTypes: [], selfNavigationTypes: [] };
  if (policy.noNavigationTypes.includes(item.type)) return [];
  const referencedPlaceIds = [...new Set([
    ...(Array.isArray(item.placeIds) ? item.placeIds : []),
    ...(item.placeId ? [item.placeId] : [])
  ])];
  if (referencedPlaceIds.length) {
    return referencedPlaceIds.map((placeId) => state.data.places.find((place) => place.id === placeId)).filter(Boolean).map((place) => ({
      id: place.id,
      label: place.nameZh || place.name,
      query: place.navigation?.query || place.googleMapsQuery || place.address || `${place.nameZh || place.name}${place.cityOrArea ? `, ${place.cityOrArea}` : ""}`,
      directUrl: Boolean(place.navigation?.url || place.googleMapsUrl),
      url: place.navigation?.url || place.googleMapsUrl || ""
    }));
  }
  const text = String(item.text || item.title || "");
  const lowerText = text.toLocaleLowerCase();
  const explicit = (state.data.mapLinks?.navigationPlaces || [])
    .filter((place) => place.matchTerms.some((term) => lowerText.includes(term.toLocaleLowerCase())))
    .map((place) => ({
      id: place.id,
      label: place.label,
      query: place.query,
      priority: place.priority || 1,
      matchIndex: Math.max(...place.matchTerms.map((term) => lowerText.lastIndexOf(term.toLocaleLowerCase())))
    }));
  const highestExplicitPriority = explicit.reduce((highest, place) => Math.max(highest, place.priority), 0);
  const selectedExplicit = highestExplicitPriority > 1
    ? explicit.filter((place) => place.priority === highestExplicitPriority)
    : explicit;

  const catalogPlaces = state.data.places
    .filter((place) => [place.name, place.nameZh].filter(Boolean).some((name) => lowerText.includes(name.toLocaleLowerCase())))
    .map((place) => ({
      id: place.id,
      label: place.nameZh || place.name,
      query: place.googleMapsUrl || [place.name, place.cityOrArea].filter(Boolean).join(", "),
      directUrl: Boolean(place.googleMapsUrl),
      matchIndex: Math.max(...[place.name, place.nameZh].filter(Boolean).map((name) => lowerText.lastIndexOf(name.toLocaleLowerCase())))
    }));

  const restaurants = state.data.restaurants
    .filter((restaurant) => lowerText.includes(restaurant.name.toLocaleLowerCase()))
    .map((restaurant) => ({
      id: `restaurant-${restaurant.name}`,
      label: restaurant.name,
      query: restaurant.googleMapsUrl || `${restaurant.name}, ${restaurant.city}`,
      directUrl: Boolean(restaurant.googleMapsUrl),
      matchIndex: lowerText.lastIndexOf(restaurant.name.toLocaleLowerCase())
    }));

  const specificExplicit = selectedExplicit.filter((place) => place.priority > 1);
  let destinations = specificExplicit.length
    ? [...specificExplicit, ...restaurants]
    : catalogPlaces.length
      ? [...catalogPlaces, ...restaurants]
      : [...selectedExplicit, ...restaurants];
  destinations = destinations.filter((place, index, all) => all.findIndex((candidate) => candidate.id === place.id) === index);

  if (policy.selfNavigationTypes.includes(item.type) && destinations.length > 1 && !specificExplicit.length) {
    destinations.sort((first, second) => second.matchIndex - first.matchIndex);
    return [destinations[0]];
  }
  return destinations;
}

function currentTripDay() {
  const today = todayForTrip();
  return state.data.days.find((day) => day.date === today)?.day || null;
}

function renderTimeline() {
  const today = currentTripDay();
  state.expandedDay = today || 1;
  $("#day-count").textContent = `${state.data.days.length} DAYS`;
  $("#timeline").innerHTML = state.data.days.map(dayCard).join("");
  $("#timeline").onclick = (event) => {
    const ticketButton = event.target.closest("[data-ticket-open]");
    if (ticketButton) {
      openTicketDialog(ticketButton.dataset.ticketOpen, ticketButton);
      return;
    }
    const toggle = event.target.closest(".day-toggle");
    if (!toggle) return;
    const card = toggle.closest(".day-card");
    const dayNumber = Number(card.dataset.day);
    const wasExpanded = toggle.getAttribute("aria-expanded") === "true";
    $$(".day-toggle", $("#timeline")).forEach((button) => button.setAttribute("aria-expanded", "false"));
    $$(".day-detail", $("#timeline")).forEach((detail) => { detail.hidden = true; });
    if (!wasExpanded) {
      toggle.setAttribute("aria-expanded", "true");
      $(`#day-detail-${dayNumber}`).hidden = false;
      state.expandedDay = dayNumber;
    } else {
      state.expandedDay = null;
    }
  };
  $("#timeline").onchange = (event) => {
    const checkbox = event.target.closest(".schedule-ticket input[type='checkbox']");
    if (!checkbox) return;
    if (checkbox.checked) state.purchasedTickets.add(checkbox.value);
    else state.purchasedTickets.delete(checkbox.value);
    saveTicketState(checkbox.value, checkbox.checked);
    updateInlineTicketState(checkbox.value, checkbox.checked);
  };
}

function updateInlineTicketState(ticketId, purchased) {
  const ticketData = state.data.ticketPlanning.items.find((item) => item.id === ticketId);
  if (!ticketData) return;
  $$(`[data-inline-ticket="${ticketId}"]`).forEach((ticket) => {
    ticket.classList.toggle("is-purchased", purchased);
    ticket.querySelector("input").checked = purchased;
    ticket.querySelector("input").setAttribute("aria-label", `${purchased ? "Mark unchecked" : "Mark reviewed / arranged"}: ${ticketTitle(ticketData)}`);
    ticket.querySelector(".schedule-ticket__status").textContent = purchased ? "Reviewed / arranged" : ticketRequirement(ticketData);
  });
  const day = state.data.days.find((item) => ticketData.dayId ? item.id === ticketData.dayId : item.day === ticketData.day);
  const dayCardElement = day ? $(`[data-day="${day.day}"]`) : null;
  const badge = dayCardElement ? $(".day-ticket-summary", dayCardElement) : null;
  const dayTickets = day ? ticketsForDay(day) : [];
  const pending = dayTickets.filter((ticket) => !isTicketPurchased(ticket)).length;
  if (!badge) return;
  badge.textContent = pending ? `${pending} items to check` : "Bookings checked";
  badge.classList.toggle("has-pending", pending > 0);
  badge.classList.toggle("is-complete", pending === 0);
}

async function loadTicketState() {
  state.purchasedTickets = new Set();
}

function saveTicketState(ticketId, completed) {
  return saveSharedChange("tickets", { id: ticketId, completed }, completed ? "upsert" : "delete").catch(console.error);
}

function rentalStatus(rental) {
  const pickup = new Date(`${rental.pickup.date}T${rental.pickup.time}:00${rental.pickup.utcOffset || "+00:00"}`);
  const dropoff = new Date(`${rental.dropoff.date}T${rental.dropoff.time}:00${rental.dropoff.utcOffset || "+00:00"}`);
  const now = new Date();
  if (now < pickup) return { label: "Until proposed pickup", target: pickup, complete: false };
  if (now < dropoff) return { label: "Until proposed return", target: dropoff, complete: false };
  return { label: "Planned return time has passed", target: dropoff, complete: true };
}

function renderRental() {
  const transport = state.data.groundTransport;
  const rental = transport.rentalCar;
  $("#rental-provider-label").textContent = rental.company;
  const status = rentalStatus(rental);
  const vehicle = rental.vehicle || {};
  const price = rental.price || {};
  $("#rental-card").innerHTML = `
    <article class="rental-panel">
      <div class="return-deadline">
        <span class="return-deadline__label">PLANNED · Rental return</span>
        <strong>${escapeHtml(formatCompactDate(rental.dropoff.date))} <time>${escapeHtml(rental.dropoff.time)}</time>  planned</strong>
        <span>${escapeHtml(rental.dropoff.timeZoneLabel)}</span>
        <p>${escapeHtml(rental.dropoff.vehicleReturnPoint)}</p>
        <div class="return-deadline__timer" id="return-deadline-timer"></div>
        <p class="return-deadline__warning">${escapeHtml(rental.dropoff.deadlineWarning)}</p>
        <small>Suggested ${escapeHtml(rental.dropoff.recommendedArrivalTime)} arrival at airport, allow time for return and check-in. </small>
      </div>
      <div class="rental-countdown" id="rental-countdown">
        <span>${escapeHtml(status.label)}</span>
        <strong>${status.complete ? `Contact ${escapeHtml(rental.company)}` : escapeHtml(countdownText(status.target))}</strong>
        <small>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)}  planned · ${escapeHtml(rental.dropoff.vehicleReturnPoint)}</small>
      </div>
      <div class="rental-details">
        <div class="rental-car">${escapeHtml(rental.company)} · ${escapeHtml(vehicle.example)}</div>
        <div class="rental-sub">${escapeHtml(vehicle.class)} · ${rental.unlimitedKilometers ? "Unlimited mileage" : "Confirm mileage terms"}</div>
        <div class="rental-stops">
          <div class="rental-stop">
            <span class="rental-stop__label">PICK UP</span>
            <div><b>${formatCompactDate(rental.pickup.date)} ${escapeHtml(rental.pickup.time)}</b><span>${escapeHtml(rental.pickup.location)}<br>${escapeHtml(rental.pickup.address)}</span></div>
          </div>
          <div class="rental-stop">
            <span class="rental-stop__label">RETURN</span>
            <div><b>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)}</b><span>${escapeHtml(rental.dropoff.vehicleReturnPoint)}<br>Suggested ${escapeHtml(rental.dropoff.recommendedArrivalTime)} arrival at airport</span></div>
          </div>
        </div>
        <div class="rental-price"><span>Estimated total / Pay Later · ${rental.rentalPeriodDays}  days</span><strong>${escapeHtml(price.currency)} ${Number(price.payAtCounter).toFixed(2)}</strong></div>
      </div>
    </article>
  `;
  const insurance = (rental.insurance || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const panels = {
    checklist: transport.rentalChecklist.map((rule) => `<li>${escapeHtml(rule)}</li>`).join(""),
    insurance,
    driving: `${(transport.drivingNotes || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}${(transport.drivingReferenceLinks || []).map((link) => `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a></li>`).join("")}`
  };
  const notes = $("#drive-notes");
  notes.innerHTML = `
    <div class="drive-note-tabs" role="group" aria-label="Rental information">
      <button type="button" aria-expanded="true" aria-controls="drive-note-content" data-drive-note="checklist">Pickup & return</button>
      <button type="button" aria-expanded="false" aria-controls="drive-note-content" data-drive-note="insurance">Protection options</button>
      <button type="button" aria-expanded="false" aria-controls="drive-note-content" data-drive-note="driving">Budget & useful links</button>
    </div>
    <div class="drive-note-panel" id="drive-note-content"><ul>${panels.checklist}</ul></div>`;
  notes.onclick = (event) => {
    const button = event.target.closest("button[data-drive-note]");
    if (!button) return;
    const collapse = button.getAttribute("aria-expanded") === "true";
    $$("button[data-drive-note]", notes).forEach((item) => item.setAttribute("aria-expanded", String(item === button && !collapse)));
    const panel = $(".drive-note-panel", notes);
    panel.hidden = collapse;
    if (!collapse) panel.innerHTML = `<ul>${panels[button.dataset.driveNote]}</ul>`;
  };
}

function updateRentalCountdown() {
  const dropoff = state.data.groundTransport.rentalCar.dropoff;
  const deadline = new Date(`${dropoff.date}T${dropoff.time}:00${dropoff.utcOffset}`);
  const remaining = deadline.getTime() - Date.now();
  $("#return-deadline-timer").textContent = remaining > 0
    ? `Until proposed return ${preciseCountdownText(deadline)}`
    : "Planned return time has passed · if you have not returned the car, Contact the rental company if needed";
  $(".return-deadline").classList.toggle("is-urgent", remaining <= 86400000);
  const panel = $("#rental-countdown");
  if (!panel) return;
  const status = rentalStatus(state.data.groundTransport.rentalCar);
  $("span", panel).textContent = status.label;
  $("strong", panel).textContent = status.complete ? `Contact ${state.data.groundTransport.rentalCar.company}` : countdownText(status.target);
}

function loadTodoState() { state.todos = []; }

function createRuntimeAdapters() {
  const storage = window.TravelRuntimeStorage;
  if (!storage?.createAdapter) throw new Error("runtime-storage.js is required");
  const persistence = state.config.persistence || { mode: "local" };
  const sharedCollections = new Set(Array.isArray(persistence.sharedCollections)
    ? persistence.sharedCollections
    : ["todos", "tickets", "ledger"]);
  const tripId = state.data.metadata.tripId;
  const enabledCollections = [
    ...(moduleEnabled("todo") ? ["todos"] : []),
    ...(moduleEnabled("itinerary") ? ["tickets"] : [])
  ];
  const localCollections = enabledCollections.filter((collection) => persistence.mode !== "d1" || !sharedCollections.has(collection));
  const d1Collections = enabledCollections.filter((collection) => persistence.mode === "d1" && sharedCollections.has(collection));
  const localAdapter = localCollections.length ? storage.createAdapter({ mode: "local", tripId, collections: localCollections }) : null;
  const d1Adapter = d1Collections.length ? storage.createAdapter({
    mode: "d1",
    tripId,
    apiBase: persistence.apiBase || "/api/trip",
    collections: d1Collections
  }) : null;
  state.runtimeAdapters = {};
  localCollections.forEach((collection) => { state.runtimeAdapters[collection] = localAdapter; });
  d1Collections.forEach((collection) => { state.runtimeAdapters[collection] = d1Adapter; });
}

async function loadSharedState() {
  const adapters = [...new Set(Object.values(state.runtimeAdapters).filter(Boolean))];
  const todoAdapter = state.runtimeAdapters.todos;
  let hasLocalTodoSnapshot = true;
  if (todoAdapter?.mode === "local" && todoAdapter.storageKey) {
    try { hasLocalTodoSnapshot = localStorage.getItem(todoAdapter.storageKey) !== null; }
    catch { hasLocalTodoSnapshot = false; }
  }
  const snapshots = await Promise.all(adapters.map(async (adapter) => [adapter, await adapter.load()]));
  const snapshotFor = (collection) => snapshots.find(([adapter]) => adapter === state.runtimeAdapters[collection])?.[1] || {};
  const todoSnapshot = snapshotFor("todos");
  const ticketSnapshot = snapshotFor("tickets");
  state.todos = Array.isArray(todoSnapshot.todos) ? todoSnapshot.todos : [];
  state.purchasedTickets = new Set((Array.isArray(ticketSnapshot.tickets) ? ticketSnapshot.tickets : []).filter((item) => item.completed).map((item) => item.id));
  const authoredTodos = state.data.preTrip?.todoItems || state.data.preTrip?.packingItems || [];
  if (todoAdapter?.mode === "local" && !hasLocalTodoSnapshot && !state.todos.length && authoredTodos.length) {
    state.todos = authoredTodos.map((item, index) => ({
      id: String(item.id || `todo-initial-${index + 1}`),
      text: String(item.text || item.title || "").trim(),
      completed: Boolean(item.completed)
    })).filter((item) => item.text);
    await Promise.all(state.todos.map((todo) => todoAdapter.applyChange("todos", todo, "upsert")));
  }
}

async function saveSharedChange(collection, value, op = "upsert") {
  const adapter = state.runtimeAdapters[collection];
  if (!adapter) return null;
  return adapter.applyChange(collection, value, op);
}

function saveTodoState() { return Promise.all(state.todos.map((todo) => saveSharedChange("todos", todo))); }

function renderTodoList() {
  const completed = state.todos.filter((todo) => todo.completed).length;
  $("#todo-progress").textContent = `${completed} / ${state.todos.length}`;
  $("#todo-list").innerHTML = state.todos.length ? state.todos.map((todo) => `
    <div class="todo-item${todo.completed ? " is-complete" : ""}" data-todo-id="${escapeHtml(todo.id)}">
      <label>
        <input type="checkbox" ${todo.completed ? "checked" : ""} aria-label="Done: ${escapeHtml(todo.text)}">
        <span class="todo-check" aria-hidden="true">✓</span>
        <span class="todo-text">${escapeHtml(todo.text)}</span>
      </label>
      <button type="button" class="todo-delete" aria-label="Delete: ${escapeHtml(todo.text)}">Delete</button>
    </div>`).join("") : `<p class="todo-empty">Your checklist is empty, Add your first task. </p>`;
}

function renderTravelPrep() {
  renderTodoList();
  $("#todo-form").onsubmit = (event) => {
    event.preventDefault();
    const input = $("#todo-input");
    const text = input.value.trim();
    if (!text) return;
    state.todos.push({ id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, completed: false });
    input.value = "";
    saveSharedChange("todos", state.todos.at(-1)).catch(console.error);
    renderTodoList();
  };
  $("#todo-list").onchange = (event) => {
    const item = event.target.closest("[data-todo-id]");
    if (!item || !event.target.matches("input[type='checkbox']")) return;
    const todo = state.todos.find((entry) => entry.id === item.dataset.todoId);
    todo.completed = event.target.checked;
    saveSharedChange("todos", todo).catch(console.error);
    renderTodoList();
  };
  $("#todo-list").onclick = (event) => {
    const button = event.target.closest(".todo-delete");
    if (!button) return;
    const item = button.closest("[data-todo-id]");
    state.todos = state.todos.filter((todo) => todo.id !== item.dataset.todoId);
    saveSharedChange("todos", { id: item.dataset.todoId }, "delete").catch(console.error);
    renderTodoList();
  };
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function localAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin ? url.href : "";
  } catch {
    return "";
  }
}

let ticketDialogOpener = null;

function openTicketDialog(ticketId, opener) {
  const ticket = state.data.ticketPlanning?.items?.find((item) => item.id === ticketId);
  const dialog = $("#ticket-dialog");
  if (!ticket || !dialog) return;
  ticketDialogOpener = opener || null;
  $("#ticket-dialog-title").textContent = ticketTitle(ticket);
  const document = ticketDocument(ticket);
  const localDocument = localAssetUrl(document?.url);
  const externalDocument = !localDocument ? safeExternalUrl(document?.url) : "";
  const officialUrl = safeExternalUrl(ticket.officialUrl || ticket.booking?.officialUrl || ticket.booking?.purchaseUrl);
  const extension = localDocument.split(/[?#]/)[0].split(".").at(-1)?.toLocaleLowerCase();
  let preview = "";
  if (localDocument && ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) {
    preview = `<img class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" alt="${escapeHtml(ticketTitle(ticket))}">`;
  } else if (localDocument) {
    preview = `<iframe class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" title="${escapeHtml(ticketTitle(ticket))}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
  }
  const links = [
    localDocument ? `<a href="${escapeHtml(localDocument)}" target="_blank" rel="noopener noreferrer">Open document in a new tab ↗</a>` : "",
    externalDocument ? `<a href="${escapeHtml(externalDocument)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document?.label || "View document")} ↗</a>` : "",
    officialUrl ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">Open official website ↗</a>` : ""
  ].filter(Boolean).join("");
  $("#ticket-dialog-body").innerHTML = `
    <p class="ticket-dialog__status">${escapeHtml(isTicketPurchased(ticket) ? "Marked reviewed / arranged" : ticketRequirement(ticket))}</p>
    ${ticketGuidance(ticket) ? `<p class="ticket-dialog__guidance">${escapeHtml(ticketGuidance(ticket))}</p>` : ""}
    ${preview || (!links ? `<p class="ticket-dialog__empty">No document or official link available. </p>` : "")}
    ${links ? `<div class="ticket-dialog__links">${links}</div>` : ""}`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#ticket-dialog-close").focus();
}

function setupTicketDialog() {
  const dialog = $("#ticket-dialog");
  if (!dialog) return;
  const close = () => {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  };
  $("#ticket-dialog-close").onclick = close;
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => {
    const body = $("#ticket-dialog-body");
    if (!body.querySelector(".ticket-dialog__preview--pdf")) body.replaceChildren();
    ticketDialogOpener?.focus({ preventScroll: true });
    ticketDialogOpener = null;
  });
}

function setupPlaceMap() {
  const panel = $("#place-map");
  const frame = $("#place-map-frame");
  let opener;
  let previousOverflow = "";
  const close = () => {
    panel.hidden = true;
    frame.src = "about:blank";
    document.body.style.overflow = previousOverflow;
    opener?.focus();
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("button[data-map-query]");
    if (!link) return;
    event.preventDefault();
    opener = link;
    $("#place-map-title").textContent = link.dataset.mapLabel;
    $("#place-map-external").href = safeExternalUrl(link.dataset.mapUrl) || mapsSearch(link.dataset.mapQuery);
    frame.title = `${link.dataset.mapLabel} Google Maps`;
    frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(link.dataset.mapQuery)}&output=embed`;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.hidden = false;
    $("#place-map-close").focus();
  });
  $("#place-map-close").onclick = close;
  panel.addEventListener("click", (event) => { if (event.target === panel) close(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const first = $("#place-map-close");
      const last = $("#place-map-external");
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}

function startCountdowns() {
  if (moduleEnabled("flights")) updateFlightCountdowns();
  if (moduleEnabled("driving")) updateRentalCountdown();
  if (!moduleEnabled("flights") && !moduleEnabled("driving")) return;
  state.countdownTimer = window.setInterval(() => {
    if (moduleEnabled("flights")) updateFlightCountdowns();
    if (moduleEnabled("driving")) updateRentalCountdown();
  }, 1000);
}

function preloadDefaultRouteMap() {
  const routeMap = state.data?.routeMap;
  const source = travelMapSource(routeMap, routeMap?.defaultRegionId);
  if (!source?.baseImage) return;
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "high";
  image.src = source.baseImage;
  state.routeMapPreload = image;
}

async function init() {
  try {
    const response = await fetch("trip-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.config = normalizeTripConfig(state.data.config);
    window.TRAVEL_PLAN_CONFIG = state.config;
    window.TRAVEL_PLAN_DATA = state.data;
    document.dispatchEvent(new CustomEvent("travel-data-ready", { detail: state.data }));
    applyModuleConfig();
    if (moduleEnabled("overview")) preloadDefaultRouteMap();
    renderHero();
    if (moduleEnabled("flights")) renderFlights();
    if (moduleEnabled("overview")) setupRouteExplorer();
    if (moduleEnabled("itinerary")) {
      setupPlaceMap();
      setupTicketDialog();
    }
    if (moduleEnabled("todo") || moduleEnabled("itinerary")) {
      createRuntimeAdapters();
      try {
        await loadSharedState();
      } catch (error) {
        console.error(`${state.config.persistence.mode === "d1" ? "Shared" : "Local"} runtime data could not be loaded`, error);
        state.todos = [];
        state.purchasedTickets = new Set();
      }
    }
    if (moduleEnabled("itinerary")) renderTimeline();
    if (moduleEnabled("driving")) renderRental();
    if (moduleEnabled("todo")) renderTravelPrep();
    if (moduleEnabled("ledger")) {
      await window.TravelLedger?.init?.({ tripId: state.data.metadata.tripId, config: state.config });
    }
    startCountdowns();
  } catch (error) {
    console.error("Travel data could not be loaded", error);
    $("#loading-error").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);

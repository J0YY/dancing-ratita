/* Ratita (Google Calendar content script)
 *
 * Key constraints from the task:
 * - Runs only on https://calendar.google.com/* (enforced by manifest matches)
 * - Must not interfere with Calendar interactions (pointer-events: none)
 * - Google Calendar DOM is dynamic → use MutationObserver + defensive selectors
 * - Only place rat on events occurring "today"
 * - Show on exactly one random event at a time; move every ~20–30 seconds
 */

(() => {
  /** How often we hop to a new event (randomized each cycle). */
  const MIN_MOVE_MS = 20_000;
  const MAX_MOVE_MS = 30_000;

  /** Visual width should match rat.css (#ratita width). Height is derived from the GIF aspect ratio. */
  const RAT_WIDTH_PX = 52;

  /** DOM ids/classes we own. */
  const RAT_ID = "ratita";

  /** State. */
  let currentEventEl = null;
  let moveTimer = null;
  let rafId = null;
  let scheduledScan = null;
  let ratFallbackDims = { w: RAT_WIDTH_PX, h: RAT_WIDTH_PX };

  /** Precompute a few "today" tokens to match against aria-label / visible text. */
  const today = new Date();
  const todayTokens = buildTodayTokens(today);

  function buildTodayTokens(d) {
    // We intentionally generate multiple locale-aware strings because Calendar aria-label
    // formats vary by view + locale (e.g. "January 30", "Jan 30", "Friday, January 30, 2026", "Today").
    const safeFmt = (options) => {
      try {
        return new Intl.DateTimeFormat(undefined, options).format(d);
      } catch {
        return "";
      }
    };

    const tokens = new Set();
    tokens.add("today"); // match case-insensitively

    const monthDayLong = safeFmt({ month: "long", day: "numeric" }); // January 30
    const monthDayShort = safeFmt({ month: "short", day: "numeric" }); // Jan 30
    const fullLong = safeFmt({
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }); // Friday, January 30, 2026
    const fullShort = safeFmt({
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric"
    }); // Fri, Jan 30, 2026
    const numeric = safeFmt({ year: "numeric", month: "numeric", day: "numeric" }); // 1/30/2026 (varies)

    [monthDayLong, monthDayShort, fullLong, fullShort, numeric].forEach((t) => {
      if (t && typeof t === "string") tokens.add(t.toLowerCase());
    });

    // Also add an ISO date to match some internal attrs (e.g., data-date="2026-01-30")
    const iso = toISODate(d);
    tokens.add(iso);

    return tokens;
  }

  function toISODate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function randInt(minInclusive, maxInclusive) {
    return Math.floor(Math.random() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = window.getComputedStyle(el);
    const opacity = Number.parseFloat(style.opacity || "1");
    if (style.display === "none" || style.visibility === "hidden" || opacity === 0)
      return false;

    // Only consider things that are at least partly on-screen.
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const onScreen =
      rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
    return onScreen;
  }

  function getLabelishText(el) {
    // Prefer aria-label (Calendar uses it heavily for accessibility),
    // but fall back to innerText on the element/near ancestors.
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    const text = el.textContent;
    if (text && text.trim()) return text.trim();
    return "";
  }

  function matchesTodayByAttributesOrLabels(el) {
    // 1) Some Calendar nodes include machine-readable dates.
    //    We'll check common patterns: data-date / aria-label on ancestors.
    const iso = toISODate(today);
    const attrDate =
      el.getAttribute("data-date") ||
      el.getAttribute("data-start-date") ||
      el.getAttribute("data-end-date") ||
      el.getAttribute("data-day");
    if (attrDate && String(attrDate).includes(iso)) return true;

    // 2) aria-label / surrounding labeled containers often include "Today" or a date string.
    //    We check the element and a few ancestors to be resilient across views (day/week/month/schedule).
    const chain = [el, el.parentElement, el.parentElement?.parentElement, el.closest("[aria-label]")];
    for (const node of chain) {
      if (!node) continue;
      const txt = getLabelishText(node).toLowerCase();
      if (!txt) continue;
      for (const token of todayTokens) {
        if (token && txt.includes(token)) return true;
      }
    }

    return false;
  }

  function findCandidateEventElements() {
    // Google Calendar is not stable; we use multiple selectors and dedupe.
    // Signals we use:
    // - elements with data-eventid (very common for event blocks)
    // - known classes in some Calendar builds (lWoQif, g3dbUc) requested in the task
    // - some event chips expose role="button" with accessible label
    const selectors = [
      "[data-eventid]",
      ".lWoQif",
      ".g3dbUc",
      // Often event blocks are clickable (role=button) and have an aria-label with details:
      '[role="button"][aria-label*=":"]',
      // Month/week grids can render event chips inside gridcells:
      '[role="gridcell"] [data-eventid]',
      '[role="gridcell"] .lWoQif',
      '[role="gridcell"] .g3dbUc'
    ];

    const out = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => out.add(el));
    }

    // Avoid adding raw gridcells directly: they frequently represent a day container (not an event),
    // which could cause the rat to sit on the day box instead of an event chip.

    return Array.from(out);
  }

  function findTodayVisibleEvents() {
    const candidates = findCandidateEventElements();
    const todayEvents = [];

    for (const el of candidates) {
      if (!isElementVisible(el)) continue;
      if (!matchesTodayByAttributesOrLabels(el)) continue;

      // Avoid selecting our own rat overlay if something weird happens.
      if (el.id === RAT_ID || el.closest(`#${RAT_ID}`)) continue;

      todayEvents.push(el);
    }

    return todayEvents;
  }

  function ensureRat() {
    let rat = document.getElementById(RAT_ID);
    if (rat) return rat;

    rat = document.createElement("div");
    rat.id = RAT_ID;

    const img = document.createElement("img");
    // Exposed as a web accessible resource in manifest.json
    img.src = chrome.runtime.getURL("assets/rat_dance.gif");
    img.alt = "Dancing rat";
    img.decoding = "async";
    img.loading = "eager";
    rat.appendChild(img);

    document.documentElement.appendChild(rat);

    // Once the GIF loads, compute a good fallback height (in case a future layout read fails),
    // and re-position if we already have a target event selected.
    img.addEventListener(
      "load",
      () => {
        if (img.naturalWidth && img.naturalHeight) {
          ratFallbackDims = {
            w: RAT_WIDTH_PX,
            h: (img.naturalHeight / img.naturalWidth) * RAT_WIDTH_PX
          };
        }
        if (currentEventEl && document.contains(currentEventEl)) {
          positionRatOverEvent(currentEventEl);
        }
      },
      { once: true }
    );

    return rat;
  }

  function removeRat() {
    const rat = document.getElementById(RAT_ID);
    if (rat) rat.remove();
  }

  function getRatDims(ratEl) {
    // Prefer actual rendered size (most accurate), but fall back to a safe estimate
    // before the image is loaded / laid out.
    try {
      const r = ratEl.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) return { w: r.width, h: r.height };
    } catch {
      // ignore
    }
    return ratFallbackDims;
  }

  function positionRatOverEvent(eventEl) {
    if (!eventEl || !(eventEl instanceof Element)) return;
    const rat = ensureRat();
    const { w: ratW, h: ratH } = getRatDims(rat);

    const rect = eventEl.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    // Positioning strategy:
    // - Sit on the top-right edge (or top-center), slightly overlapping the event
    //   so it's cute but does not cover most of the event text.
    const useTopRight = Math.random() < 0.65;
    const baseLeft = useTopRight
      ? rect.left + rect.width - ratW * 0.7
      : rect.left + rect.width / 2 - ratW / 2;
    const baseTop = rect.top - ratH * 0.55; // float a bit above the top edge

    // Convert viewport coords to document coords.
    let left = scrollX + baseLeft;
    let top = scrollY + baseTop;

    // Clamp to keep the rat on screen-ish (prevents it going negative on very top rows).
    left = Math.max(0, left);
    top = Math.max(0, top);

    // Apply (rat.css handles smooth transitions).
    rat.style.left = `${left}px`;
    rat.style.top = `${top}px`;
  }

  function pickRandomEventDifferentFromCurrent(events) {
    if (!events.length) return null;
    if (events.length === 1) return events[0];
    // Try a few times to avoid picking same event.
    for (let i = 0; i < 4; i++) {
      const candidate = events[randInt(0, events.length - 1)];
      if (candidate !== currentEventEl) return candidate;
    }
    return events[randInt(0, events.length - 1)];
  }

  function hopToRandomTodayEvent() {
    const todayEvents = findTodayVisibleEvents();

    if (!todayEvents.length) {
      currentEventEl = null;
      removeRat();
      return;
    }

    const next = pickRandomEventDifferentFromCurrent(todayEvents);
    currentEventEl = next;
    positionRatOverEvent(next);
  }

  function scheduleNextHop() {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      hopToRandomTodayEvent();
      scheduleNextHop();
    }, randInt(MIN_MOVE_MS, MAX_MOVE_MS));
  }

  function onDomMaybeChanged() {
    // Throttle expensive scans: Calendar mutates a lot.
    if (scheduledScan) return;
    scheduledScan = setTimeout(() => {
      scheduledScan = null;

      // If the currently selected event disappeared, pick a new one.
      if (currentEventEl && !document.contains(currentEventEl)) {
        currentEventEl = null;
      }

      // If we have a valid current event, just re-position (it might have moved).
      // Otherwise, try to find a new one.
      if (currentEventEl && isElementVisible(currentEventEl)) {
        positionRatOverEvent(currentEventEl);
      } else {
        hopToRandomTodayEvent();
      }
    }, 250);
  }

  function onScrollOrResize() {
    // Use rAF to avoid doing layout work too often during scroll.
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (currentEventEl && document.contains(currentEventEl) && isElementVisible(currentEventEl)) {
        positionRatOverEvent(currentEventEl);
      }
    });
  }

  function start() {
    // Initial attempt after Calendar has had a moment to render.
    setTimeout(() => {
      hopToRandomTodayEvent();
      scheduleNextHop();
    }, 700);

    // Keep up with Calendar's frequent rerenders.
    const observer = new MutationObserver(onDomMaybeChanged);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
  }

  start();
})();


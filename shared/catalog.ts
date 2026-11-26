import barriersJson from "./barriers.json" with { type: "json" };
import {
  DEFAULT_PERSONA_MIX,
  PERSONAS,
  type Barrier,
  type BarrierId,
  type Persona,
  type PersonaMix,
} from "./types.ts";

export interface SiteBarrier extends Barrier {
  siteFlag: string;
}

/** Accessible names the site-aware bots look up. Not guessed from regexes. */
export interface SiteAccessibleNames {
  menu: string[];
  open: { role: "link" | "button"; name: string }[];
  searchButton?: string;
  searchField?: string;
  terms?: string;
  submit: string;
  submitIds: string[];
  frictionConfirm?: string;
}

export const PRICING_FRICTION_DISCLOSURE =
  "60% of treatment conversions are dropped by construction (bots click through the modal; the friction is an injected drop-off). With the assumed mix, treatment cannot beat control, expected −50%. The decision isn't hard-coded, but the loss is.";

export interface SiteDef {
  id: string;
  name: string;
  headline: string;
  conversion: string;
  flagName: string;
  metricEvent: string;
  dir: string;
  hypothesis: string;
  barriers: SiteBarrier[];
  /** First-failure blockedBy the control fixture returns, per persona. */
  controlBlocked: Record<Persona, BarrierId[]>;
  /** Exact accessible names the Playwright bots use for this site. */
  accessible: SiteAccessibleNames;
  /**
   * Treatment-only friction (extra modal). `frictionKeepRate` is P(keep),
   * i.e. rand() < keepRate keeps the conversion. Pricing is a designed-to-lose
   * pipeline check of pull_to_control; the decision is not hard-coded.
   */
  harmfulFix?: {
    barrierId: "extra_confirm";
    frictionKeepRate: number;
    designedToLose: true;
    note: string;
  };
}

function barrier(
  siteId: string,
  id: BarrierId,
  wcag: string,
  title: string,
  control: string,
  treatment: string,
  blocks: Persona[],
  flagOverride?: string,
): SiteBarrier {
  return {
    id,
    flag: flagOverride ?? `${siteId}_${id}`,
    siteFlag: flagOverride ?? `${siteId}_${id}`,
    wcag,
    title,
    control,
    treatment,
    blocks,
  };
}

const checkoutJson = barriersJson as Barrier[];

const checkout: SiteDef = {
  id: "checkout",
  name: "Northline Market checkout",
  headline: "Place order",
  conversion: "order confirmed",
  flagName: "checkout_a11y",
  metricEvent: "checkout_completed",
  dir: "sites/checkout",
  hypothesis:
    "Fixing WCAG barriers (hover-only menu, unlabeled icon, non-focusable Place order, missing labels, unnamed terms checkbox, low-contrast terms) increases checkout completion for keyboard, screen-reader, and low-vision visitors. Traffic is simulated.",
  barriers: checkoutJson.map((b) => ({ ...b, siteFlag: b.flag })),
  controlBlocked: {
    mouse: [],
    keyboard: ["hover_menu"],
    "screen-reader": ["hover_menu", "unlabeled_icon"],
    "low-vision": ["low_contrast"],
  },
  accessible: {
    menu: ["Shop"],
    open: [
      { role: "link", name: "Checkout" },
      { role: "button", name: "View cart and check out" },
    ],
    terms: "terms of sale",
    submit: "Place order",
    submitIds: ["place-order"],
  },
};

const signup: SiteDef = {
  id: "signup",
  name: "Harbor Notes signup",
  headline: "Create account",
  conversion: "account created",
  flagName: "signup_a11y",
  metricEvent: "signup_completed",
  dir: "sites/signup",
  hypothesis:
    "Labelling fields, naming the terms checkbox, using a real submit button, restoring autocomplete, and raising contrast increases account creation. Traffic is simulated.",
  barriers: [
    barrier(
      "signup",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Signup fields without labels",
      "Email and password have placeholders only.",
      "Visible <label for> on every field.",
      ["screen-reader"],
    ),
    barrier(
      "signup",
      "unlabeled_terms",
      "4.1.2 / 1.3.1",
      "Unlabeled marketing checkbox",
      "Checkbox has no accessible name.",
      "A <label for> wraps the copy.",
      ["screen-reader"],
    ),
    barrier(
      "signup",
      "div_button",
      "2.1.1 / 4.1.2",
      "Non-focusable Create account",
      "Submit is a clickable div.",
      "Native <button type=\"submit\">.",
      ["keyboard", "screen-reader"],
    ),
    barrier(
      "signup",
      "autocomplete_off",
      "1.3.5 Identify Input Purpose",
      "autocomplete=off on email and password",
      "Fields disable autofill.",
      "autocomplete=email and new-password.",
      [],
    ),
    barrier(
      "signup",
      "low_contrast",
      "1.4.3 Contrast (Minimum)",
      "Low-contrast terms copy",
      "Grey-on-grey legal copy (~1.4:1).",
      "Near-black on white.",
      ["low-vision"],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: ["div_button"],
    "screen-reader": ["missing_labels"],
    "low-vision": ["low_contrast"],
  },
  accessible: {
    menu: [],
    open: [],
    terms: "Harbor Notes",
    submit: "Create account",
    submitIds: ["place-order"],
  },
};

const pricing: SiteDef = {
  id: "pricing",
  name: "Lumen Cloud pricing",
  headline: "Start trial",
  conversion: "trial started",
  flagName: "pricing_a11y",
  metricEvent: "trial_started",
  dir: "sites/pricing",
  hypothesis:
    "Making Start trial keyboard-accessible and labelled raises trial starts. A treatment-only extra confirmation step is also shipped as a 'careful conversion' fix. 60% of treatment conversions are dropped by construction (bots click through the modal; the friction is an injected drop-off). With the assumed mix, treatment cannot beat control, expected −50%. The decision isn't hard-coded, but the loss is. Traffic is simulated.",
  barriers: [
    barrier(
      "pricing",
      "hover_menu",
      "2.1.1 Keyboard",
      "Hover-only Plans menu",
      "Start trial lives in a CSS :hover menu.",
      "Menu opens on focus; Start trial is a real control.",
      ["keyboard", "screen-reader"],
    ),
    barrier(
      "pricing",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Workspace field without a label",
      "Company field is placeholder-only.",
      "Visible associated label.",
      ["screen-reader"],
    ),
    barrier(
      "pricing",
      "div_button",
      "2.1.1 / 4.1.2",
      "Non-focusable Start trial",
      "Start trial is a clickable div.",
      "Native button.",
      ["keyboard", "screen-reader"],
    ),
    barrier(
      "pricing",
      "extra_confirm",
      "n/a (treatment friction)",
      "Extra 'confirm your trial' modal",
      "No extra step in control.",
      "Treatment adds a confirmation modal before the trial starts. Intended as a safeguard; it adds a friction step.",
      [],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: ["hover_menu"],
    "screen-reader": ["hover_menu"],
    "low-vision": [],
  },
  accessible: {
    menu: ["Plans"],
    open: [{ role: "link", name: "Start trial" }],
    submit: "Start trial",
    submitIds: ["place-order"],
    frictionConfirm: "Start trial anyway",
  },
  harmfulFix: {
    barrierId: "extra_confirm",
    frictionKeepRate: 0.4,
    designedToLose: true,
    note: PRICING_FRICTION_DISCLOSURE,
  },
};

const newsletter: SiteDef = {
  id: "newsletter",
  name: "Field Post newsletter",
  headline: "Subscribe",
  conversion: "subscribed",
  flagName: "newsletter_a11y",
  metricEvent: "newsletter_subscribed",
  dir: "sites/newsletter",
  hypothesis:
    "Naming the subscribe control, labelling email, and raising privacy-copy contrast increases subscriptions. Traffic is simulated.",
  barriers: [
    barrier(
      "newsletter",
      "unlabeled_icon",
      "4.1.2 Name, Role, Value",
      "Unlabeled subscribe glyph",
      "Envelope button has no accessible name.",
      "aria-label=\"Subscribe to the newsletter\".",
      ["screen-reader"],
    ),
    barrier(
      "newsletter",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Email field without a label",
      "Placeholder only.",
      "Visible associated label.",
      ["screen-reader"],
    ),
    barrier(
      "newsletter",
      "low_contrast",
      "1.4.3 Contrast (Minimum)",
      "Low-contrast privacy note",
      "Grey-on-grey (~1.4:1).",
      "Near-black on white.",
      ["low-vision"],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: [],
    "screen-reader": ["missing_labels"],
    "low-vision": ["low_contrast"],
  },
  accessible: {
    menu: [],
    open: [],
    submit: "Subscribe to the newsletter",
    submitIds: ["subscribe"],
  },
};

const donate: SiteDef = {
  id: "donate",
  name: "River Keep donation",
  headline: "Donate",
  conversion: "donation recorded",
  flagName: "donate_a11y",
  metricEvent: "donation_completed",
  dir: "sites/donate",
  hypothesis:
    "Naming the give control, labelling amount/email, using a real button, and raising receipt-copy contrast increases donations. Traffic is simulated.",
  barriers: [
    barrier(
      "donate",
      "unlabeled_icon",
      "4.1.2",
      "Unlabeled heart control",
      "Donate glyph has no name.",
      "aria-label=\"Give to River Keep\".",
      ["screen-reader"],
    ),
    barrier(
      "donate",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Amount and email without labels",
      "Placeholders only.",
      "Visible associated labels.",
      ["screen-reader"],
    ),
    barrier(
      "donate",
      "div_button",
      "2.1.1 / 4.1.2",
      "Non-focusable Give",
      "Give is a clickable div.",
      "Native button.",
      ["keyboard", "screen-reader"],
    ),
    barrier(
      "donate",
      "low_contrast",
      "1.4.3",
      "Low-contrast receipt note",
      "Grey-on-grey (~1.4:1).",
      "Near-black on white.",
      ["low-vision"],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: ["div_button"],
    "screen-reader": ["unlabeled_icon"],
    "low-vision": ["low_contrast"],
  },
  accessible: {
    menu: [],
    open: [{ role: "button", name: "Give to River Keep" }],
    submit: "Give",
    submitIds: ["place-order"],
  },
};

const booking: SiteDef = {
  id: "booking",
  name: "North Clinic booking",
  headline: "Reserve appointment",
  conversion: "appointment reserved",
  flagName: "booking_a11y",
  metricEvent: "appointment_booked",
  dir: "sites/booking",
  hypothesis:
    "Opening the booking flow from the keyboard, labelling patient fields, and using a real Reserve button increases bookings. Traffic is simulated.",
  barriers: [
    barrier(
      "booking",
      "hover_menu",
      "2.1.1",
      "Hover-only Appointments menu",
      "Book lives in a CSS :hover menu.",
      "Menu opens on focus.",
      ["keyboard", "screen-reader"],
    ),
    barrier(
      "booking",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Patient fields without labels",
      "Name, email, and date are placeholder-only.",
      "Visible associated labels.",
      ["screen-reader"],
    ),
    barrier(
      "booking",
      "div_button",
      "2.1.1 / 4.1.2",
      "Non-focusable Reserve",
      "Reserve is a clickable div.",
      "Native button.",
      ["keyboard", "screen-reader"],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: ["hover_menu"],
    "screen-reader": ["hover_menu"],
    "low-vision": [],
  },
  accessible: {
    menu: ["Appointments"],
    open: [{ role: "link", name: "Book a visit" }],
    submit: "Reserve",
    submitIds: ["place-order"],
  },
};

const login: SiteDef = {
  id: "login",
  name: "Atlas Board login",
  headline: "Sign in",
  conversion: "signed in",
  flagName: "login_a11y",
  metricEvent: "login_completed",
  dir: "sites/login",
  hypothesis:
    "Labelling fields, naming the submit control, restoring autocomplete, and raising help-copy contrast increases sign-ins. Traffic is simulated.",
  barriers: [
    barrier(
      "login",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Login fields without labels",
      "Email and password are placeholder-only.",
      "Visible associated labels.",
      ["screen-reader"],
    ),
    barrier(
      "login",
      "unlabeled_icon",
      "4.1.2",
      "Unlabeled lock submit",
      "Submit is a glyph with no name.",
      "aria-label=\"Sign in\".",
      ["screen-reader"],
    ),
    barrier(
      "login",
      "autocomplete_off",
      "1.3.5",
      "autocomplete=off on credentials",
      "Fields disable autofill.",
      "autocomplete=username and current-password.",
      [],
    ),
    barrier(
      "login",
      "low_contrast",
      "1.4.3",
      "Low-contrast reset-password copy",
      "Grey-on-grey (~1.4:1).",
      "Near-black on white.",
      ["low-vision"],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: [],
    "screen-reader": ["missing_labels"],
    "low-vision": ["low_contrast"],
  },
  accessible: {
    menu: [],
    open: [],
    submit: "Sign in",
    submitIds: ["signin"],
  },
};

const search: SiteDef = {
  id: "search",
  name: "Northline search and cart",
  headline: "Add to cart",
  conversion: "added to cart",
  flagName: "search_a11y",
  metricEvent: "cart_add_completed",
  dir: "sites/search",
  hypothesis:
    "Naming search, labelling the query, exposing cart from the keyboard, and using a real Add to cart button increases add-to-cart. Traffic is simulated.",
  barriers: [
    barrier(
      "search",
      "unlabeled_icon",
      "4.1.2",
      "Unlabeled search glyph",
      "Search button has no accessible name.",
      "aria-label=\"Search the catalog\".",
      ["screen-reader"],
    ),
    barrier(
      "search",
      "missing_labels",
      "1.3.1 / 3.3.2",
      "Query field without a label",
      "Placeholder only.",
      "Visible associated label.",
      ["screen-reader"],
    ),
    barrier(
      "search",
      "div_button",
      "2.1.1 / 4.1.2",
      "Non-focusable Add to cart",
      "Add to cart is a clickable div.",
      "Native button.",
      ["keyboard", "screen-reader"],
    ),
    barrier(
      "search",
      "low_contrast",
      "1.4.3",
      "Low-contrast stock note",
      "Grey-on-grey shipping copy (~1.4:1).",
      "Near-black on white.",
      ["low-vision"],
    ),
  ],
  controlBlocked: {
    mouse: [],
    keyboard: ["div_button"],
    "screen-reader": ["missing_labels"],
    "low-vision": ["low_contrast"],
  },
  accessible: {
    menu: [],
    open: [],
    searchButton: "Search the catalog",
    searchField: "Search",
    submit: "Add to cart",
    submitIds: ["place-order"],
  },
};

export const SITES: SiteDef[] = [
  checkout,
  signup,
  pricing,
  newsletter,
  donate,
  booking,
  login,
  search,
];

export function getSite(id: string): SiteDef {
  const site = SITES.find((s) => s.id === id);
  if (!site) {
    throw new Error(`Unknown site "${id}". Known: ${SITES.map((s) => s.id).join(", ")}`);
  }
  return site;
}

export function siteIds(): string[] {
  return SITES.map((s) => s.id);
}

export function barrierFlagMap(site: SiteDef): Record<string, string> {
  const map: Record<string, string> = {};
  for (const b of site.barriers) map[b.id] = b.flag;
  return map;
}

/** Share of the assumed mix whose control path is blocked. Mouse is never blocked. */
export function blockedPersonaShare(
  site: SiteDef,
  mix: PersonaMix = DEFAULT_PERSONA_MIX,
): number {
  let share = 0;
  for (const persona of PERSONAS) {
    if ((site.controlBlocked[persona] ?? []).length > 0) share += mix[persona];
  }
  return share;
}

/**
 * Expected relative lift by construction: blocked personas convert 0% in
 * control, mouse users are never blocked, treatment unblocks everyone.
 * baseline cancels, so lift ≈ 1/(1 − blocked share) − 1.
 * Pricing also multiplies treatment by frictionKeepRate.
 */
export function expectedLiftByConstruction(
  site: SiteDef,
  mix: PersonaMix = DEFAULT_PERSONA_MIX,
): number {
  const blocked = blockedPersonaShare(site, mix);
  const unblocked = 1 - blocked;
  if (unblocked <= 0) return Number.POSITIVE_INFINITY;
  if (site.harmfulFix?.designedToLose) {
    return site.harmfulFix.frictionKeepRate / unblocked - 1;
  }
  return 1 / unblocked - 1;
}

/** Client config without secrets. Bootstrap fills the environment key. */
export function placeholderSiteConfig(site: SiteDef) {
  return {
    site: site.id,
    flagsmithApiUrl: "",
    flagsmithEventsUrl: "",
    flagsmithEnvironmentKey: "",
    flagName: site.flagName,
    metricEvent: site.metricEvent,
    allowMock: false,
    simulatedTrafficLabel: "SIMULATED TRAFFIC",
    barrierFlags: site.barriers.map((b) => b.flag),
    barrierFlagMap: barrierFlagMap(site),
  };
}

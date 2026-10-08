# Design and accessibility

## Principles

- **Every card answers an operational question.** Each KPI card shows its definition, reporting period,
  comparison (or an explicit "no comparison period") and sample size. Each card opens the exact records
  behind its figure. Chart cards state the question they answer.
- **No invented numbers.** With too few records a card says "Not enough data" instead of showing a
  value. Costs are totalled per currency and never converted.
- **Facts, rules and predictions look different.** A recorded fact is a neutral tag. A rule-based
  warning is an amber tag. A prediction has a dashed outline and its sample size. Each lists its
  supporting records and assumptions.
- **States.** Every data view has loading (skeleton), empty, error (translated error code with retry),
  stale (mailbox synchronisation older than 30 minutes) and insufficient-data states. A live banner
  appears when a colleague changes the record you are viewing.
- **Restrained styling.** System UI typography, an 8 px spacing rhythm, hairline borders, one accent
  colour and minimal motion (disabled under `prefers-reduced-motion`).

## Visual components

| Component | Where |
|---|---|
| KPI cards with definition, period, comparison and drill-down | Dashboard (role-specific) |
| Interactive stacked bars and columns with drill-down, tooltips, legend and table view | Dashboard |
| Crew rotation timeline (positions × weeks, uncovered slots hatched, today marker) | Rotation |
| Readiness matrix (people × requirements, for the whole assignment period) | Readiness, crew change, person |
| Mobilisation timeline (travel, accommodation, ground transport and appointments on separate tracks per person, embarkation marker, unconfirmed hatched) | Crew change |
| Calendar of movements, appointments, training and crew changes | Calendar |
| Task board grouped by status, owner or deadline | Tasks |
| Progress indicators (mobilisation, onboarding) | Crew changes, dashboard |
| Exception panel of blockers and urgent actions | Dashboard, crew change |
| Request stage timeline (draft → … → completed), with technical and business status separate | Arrangement |

## Chart colour

Charts use a categorical palette (slots: blue, orange, aqua, yellow) in a fixed order. The order was
validated for colour-vision deficiency with the dataviz validator in both themes:

- light: worst adjacent CVD ΔE 9.1 and normal-vision ΔE 22.9, both PASS;
- dark: worst adjacent CVD ΔE 8.4 and normal-vision ΔE 19.8, both PASS.

Two light-mode slots sit below 3:1 against the surface. The relief rule applies: every chart has a
legend, direct value labels and a **table view**. Segment order in stacked bars follows the validated
adjacency. Labelled timeline bars use a tint of the series colour with a solid series-colour edge and
normal text colour, so labels keep at least 4.5:1 contrast in both themes. Status colours (good,
warning, critical) are reserved for status and always appear with an icon and a label, never colour
alone. Unconfirmed arrangements and uncovered slots also use texture (hatching).

## Language

- European Portuguese and English. The English dictionary is the key source; the Portuguese one is
  typed against it, so a missing key is a compile error. Unit tests also check placeholders and look for
  untranslated strings.
- A visible language switcher sits in the top bar and on the sign-in page. Each user's preference is
  saved and applied at sign-in.
- Dates, numbers and currency use `Intl` with `pt-PT` or `en-GB`. Times always carry a zone label.
  Arrangement times are shown in the location's local time.
- Internal status codes are never shown. Names, identifiers and original message contents are never
  translated.
- Emails, invitation messages, exports and spreadsheet headings use the language of the template or
  user.

## Accessibility results (automated)

`web/e2e/app.spec.ts` runs axe-core (WCAG 2.0/2.1 A and AA) on 12 screens in Portuguese, 3 in English,
2 in dark mode, the package review and the mobile employee view: **no serious or critical violations**.

Issues found and fixed during this work:

- Link contrast within text: inline links are now underlined.
- White text on chart fills was 4.41:1: labelled bars now use tinted fills.
- Grid and table roles in the timelines and calendar: header and week rows were added.
- Horizontal overflow at 390 px: the top bar was compacted.

Other measures:

- skip link and visible focus rings;
- every chart mark is keyboard-focusable and opens its records with Enter or Space;
- dialogs trap the initial focus, close on Escape and restore focus;
- form fields have labels, and status messages use live regions;
- the layout has no horizontal page scroll at phone width, and wide tables and timelines scroll in
  their own containers;
- `forced-colors` and print styles are provided.

Not yet done: a manual screen-reader pass (NVDA/VoiceOver) and usability sessions with coordinators.

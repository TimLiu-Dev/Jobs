# 2027 U.S. Android Engineering Career & Job-Hop Command Center (616 Companies)

An end-to-end, modular web application and job-hunt CRM built for a **Mid-Level Android Software Engineer (~2–3 YOE by 2027)** transitioning from commercial fitness console engineering (Kotlin, Jetpack Compose, custom AOSP, Unix domain socket IPC, BLE/FTMS) into high-comp Mid-Level (`SWE II / L4`) or Direct Senior (`SWE III / L5 Stretch`) Android roles.

## File Architecture (Clean Separation of Data & Code)

```text
android-2027-command-center/
├── index.html       # Semantic UI layout, filters, Senior Strategy & Slide-Over CRM Drawer
├── styles.css       # Custom slider controls, scrollbars, and slide-over animations
├── companies.json   # SOURCE OF TRUTH: 616-company dataset + Tier/Metro/Checklist metadata
├── companies.js     # GENERATED from companies.json (works over file:// & HTTP)
├── build_data.py    # Validates companies.json, regenerates companies.js + the .md matrix rows
├── app.js           # Modular state controller, 5-factor scorer, CRM persistence, and exporters
└── README.md        # Architecture & usage guide
```

### Editing the dataset
Edit **only** `companies.json`, then run:

```bash
python build_data.py
```

It validates every record (IDs 1..N, tier order, allowed enum values, `$NNNk–$NNNk` comp format, metro IDs, starter IDs) and rewrites `companies.js` and the company rows of `2027_US_Android_Engineering_Target_Companies_616.md`, so the three files can never drift apart. Keep IDs stable: CRM progress in the browser is keyed by company ID.

### Why `companies.js` + `companies.json`?
- **Zero-CORS Local Execution (`file://`)**: Double-clicking `index.html` directly from your filesystem works immediately because `companies.js` attaches `window.ANDROID_COMMAND_CENTER_DATA` via a standard `<script>` tag before `app.js` runs.
- **Clean Git Diffs & Easy Maintenance**: Adding new companies or updating salary bands only touches `companies.js` / `companies.json` without scrolling past application logic.
- **Scriptable Data**: `companies.json` is included alongside `companies.js` so you can query or sync records with Python scripts or Obsidian Dataview.

## Key Capabilities
1. **Dual-Track Senior & Mid-Level System**:
   - Switch globally between **Both (Mid + Senior)**, **Mid-Level (SWE II / L4)**, and **Senior Stretch (SWE III / L5)**.
   - Includes an interactive **2027 Senior Readiness Checklist** (auto-saved in `localStorage`) and tailored **Mid vs. Senior Resume & Screen Bullets** inside every company drawer.
2. **Complete 616-Company Audit & Hygiene**:
   - Added high-value remote/WFA and hardware/Midwest targets (**Shopify**, **Klaviyo**, **Wise**, **Automattic**, **GitLab**, **Zapier**, **Plaid**, **Procore**, **Uline**, **Menards**, **Motional**, **Fetch Rewards**).
   - Flagged 8 companies as `Watchlist / Distressed` (e.g., **Interactive Strength (#24)**, **Magic Leap (#54)**, **DJI (#84)**, **iRobot (#282)**, **Character.AI (#605)**) with a 1-click hide toggle.
   - **Nov 2026 refresh (v2027.3.0):** 69 rows corrected from web-verified 2025–26 news: M&A (Paramount→WBD as Skydance, SpaceX→xAI/X, Capital One→Brex, Abbott→Exact Sciences, Coursera+Udemy, Garmin→TrainingPeaks, Brady→Honeywell scanners), IPO/take-private stage changes, Levels.fyi Nov 2026 comp for benchmark companies, RTO changes, and 2026 layoffs. The remaining 386 Band A/B/D comp ranges were linearly re-scaled to the new band key (Band C unchanged). Defunct/irrelevant rows were replaced in place (same IDs): Movano→Zepp Health, Biostrap→Pison, Whistle→Fi, Allbirds→Fabletics, Trimble Transportation→Zonar, Honeywell→Brady.
   - Some companies intentionally appear as multiple **team-level** rows (e.g., Stripe Terminal vs. Core Payments, Meta Reality Labs vs. Instagram/WhatsApp, Skydance HBO Max vs. Paramount+).
3. **9-Stage Application Pipeline CRM**:
   - Track targets across `Unreviewed → Shortlisted → Networking / Referral → Applied → OA / CodeSignal → Tech Screen → Final Loop → Offer → Pass` with JSON Backup Export/Import.
   - Each stage change is date-stamped (stage history shown in the drawer and exports).
   - Set a **Next Follow-up** date per company; rows show *Due today* / *Overdue* badges and the **⏰ Follow-ups Due** toggle filters to them.
   - **My Target Level Here** overrides the global Mid/Senior toggle for that company's drawer.
   - Career mode, sort, weights and filters are remembered between visits.
4. **Obsidian-Ready Markdown Export**:
   - Exports filtered targets and active CRM dossiers with clean YAML frontmatter ready to drop directly into your Obsidian vault.

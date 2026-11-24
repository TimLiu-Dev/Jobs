/**
 * 2027 U.S. Android Engineering Career & Job-Hop Command Center — Application Controller
 * Cleanly separated from dataset (companies.js) and presentation (index.html / styles.css).
 */

(function () {
  'use strict';

  const DATA = window.ANDROID_COMMAND_CENTER_DATA;
  if (!DATA || !Array.isArray(DATA.companies)) {
    console.error('ANDROID_COMMAND_CENTER_DATA failed to load.');
    return;
  }

  const STORAGE_KEYS = {
    CRM: 'android_cmd_2027_crm_v2',
    SENIOR_CHECKS: 'android_cmd_2027_senior_checks_v2',
    THEME: 'android_cmd_2027_theme_v2', // also read by the inline <head> script in index.html
    VIEW: 'android_cmd_2027_view_v1'
  };

  const DEFAULT_FILTERS = Object.freeze({
    pipelineStage: 'ALL',
    metro: 'ALL',
    band: 'ALL',
    levelFit: 'ALL',
    tier: 'ALL',
    wfa: 'ALL',
    interview: 'ALL',
    wlb: 'ALL',
    search: '',
    realisticYoeOnly: false,
    hideWatchlist: false,
    followUpDue: false
  });

  // ---------------------------------------------------------------------------
  // Application State
  // ---------------------------------------------------------------------------
  const state = {
    careerMode: 'BOTH',        // 'BOTH' | 'MID' | 'SENIOR'
    sortMode: 'master',        // 'master' | 'composite' | 'pay' | 'fit' | 'wlb' | 'pipeline'
    weights: {
      fit: 30,
      pay: 30,
      wlb: 15,
      lvl: 15,
      wfa: 10
    },
    filters: { ...DEFAULT_FILTERS },
    pageSize: 75,
    currentPage: 1,
    showAll: false,
    activeDrawerCompanyId: null,
    crm: loadJsonStorage(STORAGE_KEYS.CRM, {}),
    seniorChecks: loadJsonStorage(STORAGE_KEYS.SENIOR_CHECKS, {})
  };

  // ---------------------------------------------------------------------------
  // Storage & Utility Helpers
  // ---------------------------------------------------------------------------
  function loadJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn('Storage read failed for', key, err);
      return fallback;
    }
  }

  function saveJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('Storage write failed for', key, err);
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (!toast || !msgEl) return;
    msgEl.textContent = message;
    toast.classList.remove('opacity-0', 'translate-y-3');
    toast.classList.add('opacity-100', 'translate-y-0');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'translate-y-3');
    }, 2600);
  }

  const VALID_STAGE_IDS = new Set(DATA.pipelineStages.map((s) => s.id));

  // Always returns a fully-populated record so callers can safely .trim() fields,
  // even for partial records restored from an older or hand-edited JSON backup.
  function getCrmRecord(companyId) {
    const rec = state.crm[companyId] || {};
    return {
      status: VALID_STAGE_IDS.has(rec.status) ? rec.status : 'Unreviewed',
      targetLevel: rec.targetLevel || 'Auto',
      contact: typeof rec.contact === 'string' ? rec.contact : '',
      notes: typeof rec.notes === 'string' ? rec.notes : '',
      followUp: /^\d{4}-\d{2}-\d{2}$/.test(rec.followUp) ? rec.followUp : '',
      stageDates: isPlainObject(rec.stageDates) ? rec.stageDates : {},
      updatedAt: rec.updatedAt || null
    };
  }

  // Local-time YYYY-MM-DD (toISOString would shift the date for U.S. evenings).
  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function isFollowUpDue(crm) {
    return Boolean(crm.followUp) && crm.followUp <= todayLocal() && crm.status !== 'Pass' && crm.status !== 'Offer';
  }

  function formatShortDate(isoOrYmd) {
    const [y, m, d] = String(isoOrYmd).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return '';
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
  }

  function copyToClipboard(text, successMsg) {
    if (!navigator.clipboard?.writeText) {
      showToast('Clipboard unavailable here—use an export button instead.');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => showToast(successMsg),
      () => showToast('Clipboard permission denied—try Export Obsidian Note (.md).')
    );
  }

  // Keep user/company text from breaking Markdown table rows.
  function mdCell(val) {
    return String(val ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
  }

  function updateCrmRecord(companyId, patch) {
    const existing = getCrmRecord(companyId);
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...patch,
      updatedAt: now
    };
    // Record when each pipeline stage was (first) reached, for the drawer timeline.
    if (patch.status && patch.status !== existing.status && patch.status !== 'Unreviewed') {
      updated.stageDates = { ...existing.stageDates, [patch.status]: now };
    }
    if (
      updated.status === 'Unreviewed' &&
      (!updated.targetLevel || updated.targetLevel === 'Auto') &&
      !updated.contact.trim() &&
      !updated.notes.trim() &&
      !updated.followUp
    ) {
      delete state.crm[companyId];
    } else {
      state.crm[companyId] = updated;
    }
    saveJsonStorage(STORAGE_KEYS.CRM, state.crm);
  }

  // ---------------------------------------------------------------------------
  // Numeric Parsing & 5-Factor Composite Scoring Engine
  // ---------------------------------------------------------------------------
  function parseMidpointTc(tcString) {
    const nums = (tcString || '').match(/\d+/g);
    if (!nums || nums.length === 0) return 150;
    if (nums.length === 1) return parseInt(nums[0], 10);
    return (parseInt(nums[0], 10) + parseInt(nums[1], 10)) / 2;
  }

  function getActiveTcMidpoint(company) {
    if (state.careerMode === 'SENIOR') return parseMidpointTc(company.seniorTc);
    if (state.careerMode === 'MID') return parseMidpointTc(company.midTc);
    return (parseMidpointTc(company.midTc) + parseMidpointTc(company.seniorTc)) / 2;
  }

  function scoreWlb(wlb) {
    switch (wlb) {
      case 'High WLB': return 10;
      case 'Balanced': return 7.5;
      case 'Regulated / Enterprise': return 6.5;
      case 'High Pace / Startup': return 4.5;
      default: return 6;
    }
  }

  function scoreWfa(wfa) {
    switch (wfa) {
      case 'All-Remote': return 10;
      case 'WFA 60–90d': return 9.2;
      case 'WFA 20–30d': return 7.2;
      default: return 4.0;
    }
  }

  function scoreLevelFit(levelFit) {
    if (state.careerMode === 'SENIOR') {
      if (levelFit === 'Senior Stretch') return 10;
      if (levelFit === 'Mid & Senior') return 8.5;
      if (levelFit === 'Mid Pipeline Strong') return 6.5;
      return 4.5; // Senior-Only Bar (5+ YOE)
    }
    if (state.careerMode === 'MID') {
      if (levelFit === 'Mid Pipeline Strong') return 10;
      if (levelFit === 'Mid & Senior') return 8.5;
      if (levelFit === 'Senior Stretch') return 6.5;
      return 2.0; // Senior-Only Bar
    }
    // BOTH
    if (levelFit === 'Mid Pipeline Strong') return 9.5;
    if (levelFit === 'Mid & Senior') return 9.0;
    if (levelFit === 'Senior Stretch') return 8.5;
    return 3.0;
  }

  function computeCompositeScore(company) {
    const w = state.weights;
    const totalW = (w.fit + w.pay + w.wlb + w.lvl + w.wfa) || 1;

    const fitNorm = Math.min(10, Math.max(0, company.overlap));
    // Normalize TC midpoint ($110k -> 3.0, $450k+ -> 10.0)
    const tcMid = getActiveTcMidpoint(company);
    const payNorm = Math.min(10, Math.max(2, ((tcMid - 90) / 340) * 8 + 2));
    const wlbNorm = scoreWlb(company.wlb);
    const lvlNorm = scoreLevelFit(company.levelFit);
    const wfaNorm = scoreWfa(company.wfa);

    const raw =
      fitNorm * w.fit +
      payNorm * w.pay +
      wlbNorm * w.wlb +
      lvlNorm * w.lvl +
      wfaNorm * w.wfa;

    const penalty = company.statusFlag !== 'Active' ? 0.78 : 1.0;
    return Math.round((raw / totalW) * 10 * penalty); // 0 - 100 scale
  }

  // ---------------------------------------------------------------------------
  // Tailored Dual-Track Resume Bullet Generator (Mid + Senior)
  // ---------------------------------------------------------------------------
  function generateTailoredBullets(company) {
    const t = company.tier;
    const isHardwareOrOs = [1, 2, 3, 4, 5, 6, 7].includes(t);
    const isPosOrKiosk = t === 5;
    const isAutoOrRobotics = t === 6;
    const isFintech = t === 10;

    let midBullets = [];
    let seniorBullets = [];

    if (isPosOrKiosk) {
      midBullets = [
        `Built & maintained locked-down commercial Android console applications in Kotlin & Jetpack Compose with deterministic offline resilience and watchdog auto-recovery.`,
        `Implemented Unix domain socket IPC (MatrixCommService/Client) framing and serial/peripheral telemetry bridges with zero dropped state transitions.`,
        `Delivered multi-brand white-label UI theming and custom localized Input Method Editors (IMEs) for global touchscreen hardware deployments.`
      ];
      seniorBullets = [
        `Architected cross-process Unix domain socket IPC and hardware watchdog supervision across custom AOSP console SKUs, driving 99.9%+ crash/ANR-free commercial uptime.`,
        `Designed a token-driven multi-brand Jetpack Compose architecture and custom IME pipeline that scaled across diverse OEM screen densities without forked codebases.`,
        `Led end-to-end E-stop safety guards, third-party kiosk app launching, and serial protocol validation across embedded ARM64 hardware builds.`
      ];
    } else if (isAutoOrRobotics) {
      midBullets = [
        `Engineered real-time embedded Android touchscreen interfaces in Kotlin & Jetpack Compose handling continuous sensor telemetry and low-latency state updates.`,
        `Developed deterministic IPC services and hardware fault-handling state machines for mission-critical operator & in-cabin workflows.`,
        `Optimized Compose recomposition and main-thread scheduling on embedded ARM64 SoCs to sustain locked 60fps UI responsiveness.`
      ];
      seniorBullets = [
        `Owned end-to-end embedded Android HMI architecture bridging low-level Linux/HAL telemetry streams with reactive Jetpack Compose operator interfaces.`,
        `Spearheaded deterministic connection lifecycle management, safety-screen interlocks, and automated hardware-in-the-loop serial/ADB test harnesses.`,
        `Established responsive typography and multi-display layout architecture across heterogeneous cockpit/controller form factors.`
      ];
    } else if (isHardwareOrOs) {
      midBullets = [
        `Developed commercial fitness console software in Kotlin & Jetpack Compose, pairing real-time workout telemetry graphs with responsive hardware controls.`,
        `Built resilient BLE/FTMS and Unix domain socket communication layers ensuring seamless sync between physical equipment sensors and Android UI.`,
        `Eliminated UI jank and inactivity scroll snapback regressions through Coroutines/StateFlow refactoring and strict lifecycle management.`
      ];
      seniorBullets = [
        `Architected multi-brand commercial console software across AOSP and Jetpack Compose, unifying hardware IPC, localized IMEs, and real-time biometric/workout graphing.`,
        `Drove platform stability initiatives—hardening socket teardown/reconnection semantics, E-stop launch guards, and prefix-agnostic hardware provisioning.`,
        `Partnered directly with firmware and QA teams on ARM64 board bring-up, ADB diagnostic tooling, and long-horizon field reliability.`
      ];
    } else if (isFintech) {
      midBullets = [
        `Engineered deterministic state machines and high-reliability Kotlin/Coroutines data pipelines for mission-critical Android workflows.`,
        `Built clean, modular Jetpack Compose UI components backed by unidirectional MVI/MVVM state management and comprehensive unit/UI test coverage.`,
        `Hardened IPC boundaries, input validation, and error-recovery flows in high-uptime production Android applications.`
      ];
      seniorBullets = [
        `Architected modular, multi-brand Android SDK and UI layers with strict unidirectional state management, cutting cross-module coupling and regression rates.`,
        `Owned fault-tolerant background polling, connection lifecycle management, and deterministic state recovery under flaky network/hardware conditions.`,
        `Defined team-wide Compose design tokens, code-review standards, and automated verification pipelines across legacy Java/XML to Kotlin migrations.`
      ];
    } else {
      midBullets = [
        `Delivered high-craft native Android features in Kotlin & Jetpack Compose with unidirectional StateFlow/Coroutines architecture.`,
        `Modernized legacy Java/XML modules to clean, testable Kotlin/Compose components while preserving backward compatibility.`,
        `Improved user-facing responsiveness, custom keyboard/input handling, and real-time data visualization performance.`
      ];
      seniorBullets = [
        `Led end-to-end architecture for a multi-brand Jetpack Compose design system and modular Android platform serving global production fleets.`,
        `Engineered resilient background polling, lifecycle-safe state restoration, and custom input/IME integrations with measurable stability gains.`,
        `Mentored engineers through structured RFCs, automated ADB/CI test workflows, and incremental Java-to-Kotlin architectural migrations.`
      ];
    }

    return { midBullets, seniorBullets };
  }

  // ---------------------------------------------------------------------------
  // Filtering & Sorting Pipeline
  // ---------------------------------------------------------------------------
  function getFilteredAndSortedCompanies() {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();

    const filtered = DATA.companies.filter((c) => {
      const crm = getCrmRecord(c.id);

      if (f.pipelineStage !== 'ALL' && crm.status !== f.pipelineStage) return false;
      if (f.metro !== 'ALL' && !c.metros.includes(f.metro)) return false;
      if (f.band !== 'ALL' && c.band !== f.band) return false;
      if (f.levelFit !== 'ALL' && c.levelFit !== f.levelFit) return false;
      if (f.tier !== 'ALL' && String(c.tier) !== String(f.tier)) return false;

      if (f.wfa !== 'ALL') {
        if (f.wfa === 'ANY_WFA') {
          if (c.wfa === 'Hybrid / Onsite') return false;
        } else if (c.wfa !== f.wfa) {
          return false;
        }
      }

      if (f.interview !== 'ALL' && c.interview !== f.interview) return false;
      if (f.wlb !== 'ALL' && c.wlb !== f.wlb) return false;
      if (f.realisticYoeOnly && c.levelFit === 'Senior-Only Bar') return false;
      if (f.hideWatchlist && c.statusFlag !== 'Active') return false;
      if (f.followUpDue && !isFollowUpDue(crm)) return false;

      if (q) {
        const tierLabel = DATA.tiers[String(c.tier)] || '';
        const haystack = [
          `#${c.id}`,
          c.name,
          c.hq,
          c.metros.join(' '),
          c.stage,
          `band ${c.band}`,
          c.midTc,
          c.seniorTc,
          c.wfa,
          c.wlb,
          c.interview,
          c.levelFit,
          c.statusFlag,
          c.stackNote,
          tierLabel,
          crm.status,
          crm.contact,
          crm.notes
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    // Attach composite score
    const enriched = filtered.map((c) => ({
      ...c,
      compositeScore: computeCompositeScore(c)
    }));

    const stageOrder = DATA.pipelineStages.reduce((acc, s, i) => {
      acc[s.id] = i;
      return acc;
    }, {});

    enriched.sort((a, b) => {
      switch (state.sortMode) {
        case 'composite':
          return b.compositeScore - a.compositeScore || a.id - b.id;
        case 'pay':
          return getActiveTcMidpoint(b) - getActiveTcMidpoint(a) || b.overlap - a.overlap || a.id - b.id;
        case 'fit':
          return b.overlap - a.overlap || getActiveTcMidpoint(b) - getActiveTcMidpoint(a) || a.id - b.id;
        case 'wlb':
          return scoreWlb(b.wlb) - scoreWlb(a.wlb) || getActiveTcMidpoint(b) - getActiveTcMidpoint(a) || a.id - b.id;
        case 'pipeline': {
          const sa = getCrmRecord(a.id).status;
          const sb = getCrmRecord(b.id).status;
          // Active stages (Offer -> Shortlisted) first, Unreviewed & Pass last
          const rankStage = (st) => {
            if (st === 'Unreviewed') return 50;
            if (st === 'Pass') return 99;
            return 20 - (stageOrder[st] ?? 0);
          };
          return rankStage(sa) - rankStage(sb) || a.id - b.id;
        }
        case 'master':
        default:
          return a.id - b.id;
      }
    });

    return enriched;
  }

  // ---------------------------------------------------------------------------
  // Badge Styling Helpers
  // ---------------------------------------------------------------------------
  function getBandBadgeClass(band) {
    switch (band) {
      case 'A':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/90 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700/70';
      case 'B':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-950/90 dark:text-blue-300 border-blue-300 dark:border-blue-700/70';
      case 'C':
        return 'bg-violet-100 text-violet-800 dark:bg-violet-950/90 dark:text-violet-300 border-violet-300 dark:border-violet-700/70';
      default:
        return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-300 dark:border-slate-700';
    }
  }

  function getLevelFitBadgeClass(levelFit) {
    switch (levelFit) {
      case 'Mid Pipeline Strong':
        return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 border-emerald-300/80 dark:border-emerald-800/70';
      case 'Senior Stretch':
        return 'bg-indigo-50 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300 border-indigo-300/80 dark:border-indigo-800/70';
      case 'Senior-Only Bar':
        return 'bg-amber-50 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border-amber-300/80 dark:border-amber-800/70';
      default:
        return 'bg-slate-100 text-slate-700 dark:bg-slate-800/90 dark:text-slate-300 border-slate-300/80 dark:border-slate-700';
    }
  }

  function getWfaBadgeClass(wfa) {
    if (wfa === 'All-Remote') {
      return 'bg-sky-100 text-sky-800 dark:bg-sky-950/80 dark:text-sky-300 border-sky-300 dark:border-sky-800/70';
    }
    if (wfa === 'WFA 60–90d') {
      return 'bg-teal-100 text-teal-800 dark:bg-teal-950/80 dark:text-teal-300 border-teal-300 dark:border-teal-800/70';
    }
    if (wfa === 'WFA 20–30d') {
      return 'bg-indigo-50 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/60';
    }
    return 'bg-slate-100 text-slate-600 dark:bg-slate-800/80 dark:text-slate-400 border-slate-200 dark:border-slate-700/70';
  }

  function getPipelineSelectClass(status) {
    const found = DATA.pipelineStages.find((s) => s.id === status);
    return found ? found.badgeClass : DATA.pipelineStages[0].badgeClass;
  }

  // ---------------------------------------------------------------------------
  // Rendering Functions
  // ---------------------------------------------------------------------------
  function renderStaticDropdowns() {
    const tierSelect = document.getElementById('filter-tier');
    if (tierSelect) {
      Object.entries(DATA.tiers).forEach(([num, label]) => {
        const opt = document.createElement('option');
        opt.value = num;
        opt.textContent = label;
        tierSelect.appendChild(opt);
      });
    }

    const drawerStatusSelect = document.getElementById('drawer-crm-status');
    if (drawerStatusSelect) {
      DATA.pipelineStages.forEach((st) => {
        const opt = document.createElement('option');
        opt.value = st.id;
        opt.textContent = st.label;
        drawerStatusSelect.appendChild(opt);
      });
    }
  }

  function renderSeniorChecklist() {
    const container = document.getElementById('senior-checklist-container');
    const badge = document.getElementById('senior-readiness-badge');
    const pctEl = document.getElementById('senior-readiness-pct');
    const barEl = document.getElementById('senior-readiness-bar');
    if (!container) return;

    const list = DATA.seniorReadinessChecklist || [];
    const completedCount = list.filter((item) => Boolean(state.seniorChecks[item.id])).length;
    const pct = list.length ? Math.round((completedCount / list.length) * 100) : 0;

    if (badge) badge.textContent = `${completedCount}/${list.length} Senior Milestones Ready`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (barEl) barEl.style.width = `${pct}%`;

    container.innerHTML = list
      .map((item) => {
        const checked = Boolean(state.seniorChecks[item.id]);
        return `
          <label class="flex items-start gap-2 p-2 rounded-lg border ${
            checked
              ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-300/70 dark:border-emerald-800/60'
              : 'bg-white dark:bg-slate-900/90 border-slate-200 dark:border-slate-800'
          } cursor-pointer hover:border-indigo-400 transition">
            <input type="checkbox" data-check-id="${item.id}" ${checked ? 'checked' : ''} class="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
            <div class="text-[11px] leading-snug">
              <div class="font-bold ${checked ? 'line-through text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-slate-100'}">${escapeHtml(item.title)}</div>
              <div class="text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(item.detail)}</div>
            </div>
          </label>
        `;
      })
      .join('');
  }

  function renderMetroPillsAndStrip() {
    const pillsContainer = document.getElementById('metro-pills');
    const stripGrid = document.getElementById('metro-cards-grid');
    const activeLabel = document.getElementById('active-metro-label');

    // Compute counts per metro
    const metroStats = {};
    DATA.metros.forEach((m) => {
      const subset =
        m.id === 'ALL'
          ? DATA.companies
          : DATA.companies.filter((c) => c.metros.includes(m.id));
      metroStats[m.id] = {
        total: subset.length,
        bandAB: subset.filter((c) => c.band === 'A' || c.band === 'B').length,
        midFriendly: subset.filter((c) => c.levelFit !== 'Senior-Only Bar').length
      };
    });

    if (activeLabel) {
      const found = DATA.metros.find((m) => m.id === state.filters.metro);
      activeLabel.textContent = found
        ? `${found.label} (${metroStats[found.id].total} companies)`
        : 'Showing all U.S. metros';
    }

    if (pillsContainer) {
      pillsContainer.innerHTML = DATA.metros
        .map((m) => {
          const active = state.filters.metro === m.id;
          const cnt = metroStats[m.id].total;
          return `
            <button type="button" data-metro="${escapeHtml(m.id)}" class="metro-pill px-2.5 py-1.5 rounded-xl text-xs font-semibold transition inline-flex items-center gap-1.5 ${
              active
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-950 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-800'
            }">
              <span>${escapeHtml(m.label)}</span>
              <span class="font-mono text-[10px] px-1.5 py-0.2 rounded-full ${
                active
                  ? 'bg-white/20 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
              }">${cnt}</span>
            </button>
          `;
        })
        .join('');
    }

    if (stripGrid) {
      stripGrid.innerHTML = DATA.metros
        .filter((m) => m.id !== 'ALL')
        .map((m) => {
          const s = metroStats[m.id];
          const active = state.filters.metro === m.id;
          return `
            <button type="button" data-metro-card="${escapeHtml(m.id)}" class="text-left p-3.5 rounded-xl border transition ${
              active
                ? 'bg-sky-50 dark:bg-sky-950/60 border-sky-500 ring-2 ring-sky-500/20'
                : 'bg-slate-50 dark:bg-slate-950/80 border-slate-200 dark:border-slate-800 hover:border-sky-400 dark:hover:border-sky-700'
            }">
              <div class="flex items-center justify-between gap-1">
                <span class="text-xs font-extrabold text-slate-900 dark:text-white">${escapeHtml(m.label)}</span>
                <span class="font-mono text-xs font-bold text-sky-700 dark:text-sky-300">${s.total}</span>
              </div>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">${escapeHtml(m.note)}</p>
              <div class="mt-2.5 pt-2 border-t border-slate-200 dark:border-slate-800/80 flex items-center justify-between text-[10px] font-mono">
                <span class="text-emerald-700 dark:text-emerald-400 font-bold">Band A/B: ${s.bandAB}</span>
                <span class="text-indigo-700 dark:text-indigo-400 font-bold">2–3 YOE: ${s.midFriendly}</span>
              </div>
            </button>
          `;
        })
        .join('');
    }
  }

  function renderPipelineFunnel() {
    const bar = document.getElementById('pipeline-funnel-bar');
    const activeBadge = document.getElementById('crm-active-badge');
    if (!bar) return;

    const counts = {};
    DATA.pipelineStages.forEach((s) => (counts[s.id] = 0));
    DATA.companies.forEach((c) => {
      const st = getCrmRecord(c.id).status;
      counts[st] = (counts[st] || 0) + 1;
    });

    const activeTargets = DATA.companies.filter((c) => {
      const st = getCrmRecord(c.id).status;
      return st !== 'Unreviewed' && st !== 'Pass';
    }).length;

    if (activeBadge) {
      activeBadge.textContent = `${activeTargets} Active Target${activeTargets === 1 ? '' : 's'}`;
    }

    const allSelected = state.filters.pipelineStage === 'ALL';
    const allBtn = `
      <button type="button" data-stage="ALL" class="stage-pill px-2.5 py-1.5 rounded-xl text-xs font-semibold border transition inline-flex items-center gap-1.5 ${
        allSelected
          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
          : 'bg-slate-100 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-800 hover:border-indigo-400'
      }">
        <span>All Stages</span>
        <span class="font-mono text-[10px] px-1.5 rounded-full ${allSelected ? 'bg-white/20 text-white' : 'bg-slate-200 dark:bg-slate-800'}">${DATA.companies.length}</span>
      </button>
    `;

    const stageBtns = DATA.pipelineStages
      .map((s) => {
        const active = state.filters.pipelineStage === s.id;
        return `
          <button type="button" data-stage="${escapeHtml(s.id)}" class="stage-pill px-2.5 py-1.5 rounded-xl text-xs font-semibold border transition inline-flex items-center gap-1.5 ${
            active
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
              : `${s.badgeClass} hover:opacity-90`
          }">
            <span>${escapeHtml(s.label)}</span>
            <span class="font-mono text-[10px] px-1.5 rounded-full ${active ? 'bg-white/20 text-white' : 'bg-black/10 dark:bg-white/10'}">${counts[s.id] || 0}</span>
          </button>
        `;
      })
      .join('');

    bar.innerHTML = allBtn + stageBtns;
  }

  function renderKpis(filteredList) {
    const totalEl = document.getElementById('kpi-filtered');
    const hcEl = document.getElementById('kpi-high-comp');
    const hcSubEl = document.getElementById('kpi-high-comp-sub');
    const lvlEl = document.getElementById('kpi-level-fit');
    const wfaEl = document.getElementById('kpi-wfa');

    const bandA = filteredList.filter((c) => c.band === 'A').length;
    const bandB = filteredList.filter((c) => c.band === 'B').length;
    const levelRealistic = filteredList.filter((c) => c.levelFit !== 'Senior-Only Bar').length;
    const wfaCount = filteredList.filter((c) => c.wfa !== 'Hybrid / Onsite').length;

    if (totalEl) totalEl.textContent = filteredList.length;
    if (hcEl) hcEl.textContent = bandA + bandB;
    if (hcSubEl) hcSubEl.textContent = `A: ${bandA} • B: ${bandB}`;
    if (lvlEl) lvlEl.textContent = levelRealistic;
    if (wfaEl) wfaEl.textContent = wfaCount;
  }

  function renderFollowUpBadge(crm) {
    if (!crm.followUp || crm.status === 'Pass' || crm.status === 'Offer') return '';
    const overdue = crm.followUp < todayLocal();
    const due = isFollowUpDue(crm);
    const cls = overdue
      ? 'text-rose-700 dark:text-rose-300'
      : due
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-slate-500 dark:text-slate-400';
    const label = overdue ? 'Overdue' : due ? 'Due today' : 'Follow up';
    return `<div class="mt-1 text-[10px] font-semibold ${cls}">⏰ ${label} ${escapeHtml(formatShortDate(crm.followUp))}</div>`;
  }

  function renderCompCell(company) {
    if (state.careerMode === 'MID') {
      return `
        <div class="flex items-center gap-1.5">
          <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border ${getBandBadgeClass(company.band)}">${company.band}</span>
          <span class="font-mono text-xs font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums">${escapeHtml(company.midTc)}</span>
        </div>
        <div class="text-[10px] font-mono text-slate-500 mt-0.5">Sr: ${escapeHtml(company.seniorTc)}</div>
      `;
    }
    if (state.careerMode === 'SENIOR') {
      return `
        <div class="flex items-center gap-1.5">
          <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border ${getBandBadgeClass(company.band)}">${company.band}</span>
          <span class="font-mono text-xs font-extrabold text-indigo-700 dark:text-indigo-300 tabular-nums">${escapeHtml(company.seniorTc)}</span>
        </div>
        <div class="text-[10px] font-mono text-slate-500 mt-0.5">Mid: ${escapeHtml(company.midTc)}</div>
      `;
    }
    return `
      <div class="flex items-center gap-1.5">
        <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border ${getBandBadgeClass(company.band)}">${company.band}</span>
        <span class="font-mono text-xs font-bold text-slate-900 dark:text-slate-100 tabular-nums">${escapeHtml(company.midTc)}</span>
      </div>
      <div class="text-[11px] font-mono font-semibold text-indigo-600 dark:text-indigo-400 tabular-nums mt-0.5">Sr: ${escapeHtml(company.seniorTc)}</div>
    `;
  }

  function renderTableAndCards(filteredList) {
    const tbody = document.getElementById('table-body');
    const mobileWrapper = document.getElementById('mobile-cards-wrapper');
    const emptyState = document.getElementById('empty-state');
    const desktopWrapper = document.getElementById('desktop-table-wrapper');
    const paginationFooter = document.getElementById('pagination-footer');
    const rangeText = document.getElementById('results-range-text');
    const showAllBtn = document.getElementById('btn-toggle-show-all');
    const thScore = document.getElementById('th-score');
    const thComp = document.getElementById('th-comp');

    if (thComp) {
      thComp.textContent =
        state.careerMode === 'MID'
          ? 'Mid-Level TC (SWE II)'
          : state.careerMode === 'SENIOR'
          ? 'Senior Stretch TC (L5)'
          : 'Comp (Mid / Senior)';
    }

    const showScoreCol = state.sortMode === 'composite';
    if (thScore) {
      thScore.classList.toggle('hidden', !showScoreCol);
    }

    const total = filteredList.length;
    // Desktop wrapper is "hidden lg:block": toggle lg:block (not hidden) so the
    // table never leaks onto mobile alongside the card view.
    if (total === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (desktopWrapper) desktopWrapper.classList.remove('lg:block');
      if (mobileWrapper) mobileWrapper.classList.add('hidden');
      if (paginationFooter) paginationFooter.classList.add('hidden');
      if (rangeText) rangeText.textContent = 'Showing 0 of 0';
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    if (desktopWrapper) desktopWrapper.classList.add('lg:block');
    if (mobileWrapper) mobileWrapper.classList.remove('hidden');
    if (paginationFooter) paginationFooter.classList.remove('hidden');

    const effectivePageSize = state.showAll ? total : state.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
    if (state.currentPage > totalPages) state.currentPage = totalPages;

    const startIdx = (state.currentPage - 1) * effectivePageSize;
    const endIdx = Math.min(total, startIdx + effectivePageSize);
    const pageItems = filteredList.slice(startIdx, endIdx);

    if (rangeText) {
      rangeText.textContent = `Showing ${startIdx + 1}–${endIdx} of ${total}`;
    }
    if (showAllBtn) {
      showAllBtn.textContent = state.showAll ? `Paginate (${state.pageSize}/page)` : `Show All ${total}`;
    }

    // Build CRM stage options HTML once
    const buildStageOptions = (selected) =>
      DATA.pipelineStages
        .map(
          (st) =>
            `<option value="${escapeHtml(st.id)}" ${st.id === selected ? 'selected' : ''}>${escapeHtml(
              st.label
            )}</option>`
        )
        .join('');

    // Render Desktop Rows
    if (tbody) {
      tbody.innerHTML = pageItems
        .map((c) => {
          const crm = getCrmRecord(c.id);
          const isWatchlist = c.statusFlag !== 'Active';
          const hasNotes = Boolean(crm.notes.trim() || crm.contact.trim());
          return `
            <tr data-company-id="${c.id}" tabindex="0" class="company-row cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 hover:bg-indigo-50/60 dark:hover:bg-slate-800/60 ${
              isWatchlist ? 'bg-rose-50/40 dark:bg-rose-950/20' : ''
            }">
              <td class="py-3 pl-4 pr-2 align-top" onclick="event.stopPropagation()">
                <select data-crm-row-select="${c.id}" aria-label="Pipeline status for ${escapeHtml(
            c.name
          )}" class="w-full rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/30 ${getPipelineSelectClass(
            crm.status
          )}">
                  ${buildStageOptions(crm.status)}
                </select>
                ${
                  hasNotes
                    ? `<div class="mt-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-400 truncate">📝 ${escapeHtml(
                        crm.contact || crm.notes
                      )}</div>`
                    : ''
                }
                ${renderFollowUpBadge(crm)}
              </td>
              <td class="py-3 px-2 align-top font-mono text-xs font-bold text-slate-500 dark:text-slate-400 tabular-nums">
                #${c.id}
              </td>
              <td class="py-3 px-3 align-top">
                <div class="font-bold text-slate-900 dark:text-white leading-snug flex flex-wrap items-center gap-1.5">
                  <span>${escapeHtml(c.name)}</span>
                  ${
                    isWatchlist
                      ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-300 dark:border-rose-800">Watchlist</span>`
                      : ''
                  }
                </div>
                <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Tier ${c.tier} • ${escapeHtml(c.stage)}
                </div>
              </td>
              <td class="py-3 px-3 align-top">
                <div class="text-xs font-medium text-slate-800 dark:text-slate-200">${escapeHtml(c.hq)}</div>
                <div class="flex flex-wrap gap-1 mt-1">
                  ${c.metros
                    .map(
                      (m) =>
                        `<span class="px-1.5 py-0.2 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">${escapeHtml(
                          m
                        )}</span>`
                    )
                    .join('')}
                </div>
              </td>
              <td class="py-3 px-3 align-top">
                ${renderCompCell(c)}
              </td>
              <td class="py-3 px-3 align-top">
                <div class="font-mono text-xs font-bold text-slate-800 dark:text-slate-200">${c.overlap}/10 Stack</div>
                <span class="inline-block mt-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${getLevelFitBadgeClass(
                  c.levelFit
                )}">
                  ${escapeHtml(c.levelFit)}
                </span>
              </td>
              <td class="py-3 px-3 align-top">
                <span class="inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold border ${getWfaBadgeClass(
                  c.wfa
                )}">
                  ${escapeHtml(c.wfa)}
                </span>
                <div class="text-[11px] text-slate-600 dark:text-slate-400 mt-1">${escapeHtml(c.wlb)}</div>
              </td>
              <td class="${
                showScoreCol ? '' : 'hidden'
              } py-3 px-3 align-top text-right font-mono font-extrabold text-sm text-amber-600 dark:text-amber-400 tabular-nums">
                ${c.compositeScore}
              </td>
              <td class="py-3 pl-3 pr-4 align-top">
                <span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 mb-1">
                  ${escapeHtml(c.interview)}
                </span>
                <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">${escapeHtml(c.stackNote)}</p>
              </td>
            </tr>
          `;
        })
        .join('');
    }

    // Render Mobile / Tablet Cards
    if (mobileWrapper) {
      mobileWrapper.innerHTML = pageItems
        .map((c) => {
          const crm = getCrmRecord(c.id);
          const isWatchlist = c.statusFlag !== 'Active';
          return `
            <div data-company-id="${c.id}" tabindex="0" class="company-row focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 p-4 space-y-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
              isWatchlist ? 'bg-rose-50/40 dark:bg-rose-950/20' : ''
            }">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-mono text-xs font-bold text-slate-500">#${c.id}</span>
                    <span class="font-bold text-sm text-slate-900 dark:text-white">${escapeHtml(c.name)}</span>
                    ${
                      isWatchlist
                        ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">Watchlist</span>`
                        : ''
                    }
                  </div>
                  <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Tier ${c.tier} • ${escapeHtml(c.hq)}
                  </div>
                </div>
                <div onclick="event.stopPropagation()" class="flex-shrink-0 text-right">
                  <select data-crm-row-select="${c.id}" aria-label="Pipeline status for ${escapeHtml(
            c.name
          )}" class="rounded-lg border px-2 py-1 text-xs font-semibold ${getPipelineSelectClass(crm.status)}">
                    ${buildStageOptions(crm.status)}
                  </select>
                  ${renderFollowUpBadge(crm)}
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span class="px-2 py-0.5 rounded font-mono font-bold border ${getBandBadgeClass(c.band)}">Band ${c.band}: ${escapeHtml(
            c.midTc
          )} (Sr: ${escapeHtml(c.seniorTc)})</span>
                <span class="px-2 py-0.5 rounded font-semibold border ${getLevelFitBadgeClass(c.levelFit)}">${escapeHtml(
            c.levelFit
          )}</span>
                <span class="px-2 py-0.5 rounded font-semibold border ${getWfaBadgeClass(c.wfa)}">${escapeHtml(
            c.wfa
          )}</span>
                <span class="px-2 py-0.5 rounded font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">${
                  c.overlap
                }/10 Fit</span>
                ${
                  showScoreCol
                    ? `<span class="px-2 py-0.5 rounded font-mono font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">Score: ${c.compositeScore}</span>`
                    : ''
                }
              </div>

              <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">${escapeHtml(c.stackNote)}</p>
            </div>
          `;
        })
        .join('');
    }

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const curEl = document.getElementById('page-current');
    const totEl = document.getElementById('page-total');
    const btnContainer = document.getElementById('page-buttons');

    if (curEl) curEl.textContent = state.currentPage;
    if (totEl) totEl.textContent = totalPages;
    if (!btnContainer) return;

    if (state.showAll || totalPages <= 1) {
      btnContainer.innerHTML = '';
      return;
    }

    const pages = [];
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || Math.abs(p - state.currentPage) <= 1) {
        pages.push(p);
      } else if (pages[pages.length - 1] !== '...') {
        pages.push('...');
      }
    }

    const prevBtn = `<button type="button" data-page="${Math.max(1, state.currentPage - 1)}" ${
      state.currentPage === 1 ? 'disabled' : ''
    } class="px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40">Prev</button>`;

    const numBtns = pages
      .map((p) => {
        if (p === '...') return `<span class="px-1.5 text-xs text-slate-400">…</span>`;
        const active = p === state.currentPage;
        return `<button type="button" data-page="${p}" class="px-2.5 py-1 rounded-lg text-xs font-mono font-bold border transition ${
          active
            ? 'bg-indigo-600 text-white border-indigo-600'
            : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:border-indigo-400'
        }">${p}</button>`;
      })
      .join('');

    const nextBtn = `<button type="button" data-page="${Math.min(totalPages, state.currentPage + 1)}" ${
      state.currentPage === totalPages ? 'disabled' : ''
    } class="px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40">Next</button>`;

    btnContainer.innerHTML = prevBtn + numBtns + nextBtn;
  }

  function updateResetVisibility() {
    const f = state.filters;
    const isDirty =
      f.pipelineStage !== 'ALL' ||
      f.metro !== 'ALL' ||
      f.band !== 'ALL' ||
      f.levelFit !== 'ALL' ||
      f.tier !== 'ALL' ||
      f.wfa !== 'ALL' ||
      f.interview !== 'ALL' ||
      f.wlb !== 'ALL' ||
      f.search.trim() !== '' ||
      f.realisticYoeOnly ||
      f.hideWatchlist ||
      f.followUpDue;

    const resetBtn = document.getElementById('btn-reset-filters');
    if (resetBtn) resetBtn.classList.toggle('hidden', !isDirty);

    const clearSearchBtn = document.getElementById('btn-clear-search');
    if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', f.search.trim() === '');
  }

  function refreshAll() {
    updateResetVisibility();
    renderPipelineFunnel();
    renderMetroPillsAndStrip();
    renderFollowUpCount();
    const list = getFilteredAndSortedCompanies();
    renderKpis(list);
    renderTableAndCards(list);
    saveViewState();
  }

  function renderFollowUpCount() {
    const el = document.getElementById('followup-count');
    if (!el) return;
    el.textContent = DATA.companies.filter((c) => isFollowUpDue(getCrmRecord(c.id))).length;
  }

  // ---------------------------------------------------------------------------
  // View-State Persistence (mode, sort, weights, filters survive a reload)
  // ---------------------------------------------------------------------------
  function saveViewState() {
    saveJsonStorage(STORAGE_KEYS.VIEW, {
      careerMode: state.careerMode,
      sortMode: state.sortMode,
      weights: state.weights,
      filters: state.filters,
      showAll: state.showAll
    });
  }

  function restoreViewState() {
    const saved = loadJsonStorage(STORAGE_KEYS.VIEW, null);
    if (!isPlainObject(saved)) return;
    if (['BOTH', 'MID', 'SENIOR'].includes(saved.careerMode)) state.careerMode = saved.careerMode;
    if (['master', 'composite', 'pay', 'fit', 'wlb', 'pipeline'].includes(saved.sortMode)) state.sortMode = saved.sortMode;
    if (isPlainObject(saved.weights)) {
      Object.keys(state.weights).forEach((k) => {
        const v = Number(saved.weights[k]);
        if (Number.isFinite(v) && v >= 0 && v <= 100) state.weights[k] = v;
      });
    }
    if (isPlainObject(saved.filters)) {
      Object.keys(DEFAULT_FILTERS).forEach((k) => {
        if (typeof saved.filters[k] === typeof DEFAULT_FILTERS[k]) state.filters[k] = saved.filters[k];
      });
      // Drop saved values that no longer exist in the dataset.
      const f = state.filters;
      if (!DATA.metros.some((m) => m.id === f.metro)) f.metro = 'ALL';
      if (f.pipelineStage !== 'ALL' && !VALID_STAGE_IDS.has(f.pipelineStage)) f.pipelineStage = 'ALL';
      if (!['ALL', 'A', 'B', 'C', 'D'].includes(f.band)) f.band = 'ALL';
      if (f.levelFit !== 'ALL' && !DATA.companies.some((c) => c.levelFit === f.levelFit)) f.levelFit = 'ALL';
    }
    state.showAll = saved.showAll === true;
  }

  // Push restored state into the static controls, then render once per mode/sort setter.
  function syncControlsToState() {
    const f = state.filters;
    const setSelect = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = f[key];
      if (el.value !== f[key]) {
        f[key] = 'ALL'; // saved option no longer offered
        el.value = 'ALL';
      }
    };
    const searchEl = document.getElementById('search-input');
    if (searchEl) searchEl.value = f.search;
    setSelect('filter-tier', 'tier');
    setSelect('filter-wfa', 'wfa');
    setSelect('filter-interview', 'interview');
    setSelect('filter-wlb', 'wlb');
    const w = state.weights;
    applyWeightSliders(w.fit, w.pay, w.wlb, w.lvl, w.wfa);
    syncPillButtons();
    setCareerMode(state.careerMode);
    setSortMode(state.sortMode);
  }

  // ---------------------------------------------------------------------------
  // Slide-Over Company Detail Drawer
  // ---------------------------------------------------------------------------
  function openDrawer(companyId) {
    const company = DATA.companies.find((c) => c.id === companyId);
    if (!company) return;

    state.activeDrawerCompanyId = companyId;
    const crm = getCrmRecord(companyId);

    document.getElementById('drawer-id-badge').textContent = `#${company.id}`;
    document.getElementById('drawer-stage-badge').textContent = company.stage;

    const lvlBadge = document.getElementById('drawer-levelfit-badge');
    lvlBadge.textContent = company.levelFit;
    lvlBadge.className = `text-xs font-semibold px-2 py-0.5 rounded-md border ${getLevelFitBadgeClass(company.levelFit)}`;

    const wfaBadge = document.getElementById('drawer-wfa-badge');
    wfaBadge.textContent = company.wfa;
    wfaBadge.className = `text-xs font-semibold px-2 py-0.5 rounded-md border ${getWfaBadgeClass(company.wfa)}`;

    document.getElementById('drawer-title').textContent = company.name;
    document.getElementById('drawer-hq').textContent = `${company.hq} • Hubs: ${company.metros.join(', ')}`;

    const watchlistAlert = document.getElementById('drawer-watchlist-alert');
    watchlistAlert.classList.toggle('hidden', company.statusFlag === 'Active');

    document.getElementById('drawer-mid-tc').textContent = company.midTc;
    document.getElementById('drawer-senior-tc').textContent = company.seniorTc;

    // Highlight the level card: per-company "My Target Level" wins over the global toggle.
    const midCard = document.getElementById('drawer-card-mid');
    const srCard = document.getElementById('drawer-card-senior');
    const effectiveLevel =
      crm.targetLevel === 'Mid-Level (SWE II / L4)'
        ? 'MID'
        : crm.targetLevel === 'Senior (SWE III / L5)'
        ? 'SENIOR'
        : state.careerMode;
    midCard.classList.toggle('ring-2', effectiveLevel === 'MID');
    midCard.classList.toggle('ring-emerald-500', effectiveLevel === 'MID');
    srCard.classList.toggle('ring-2', effectiveLevel === 'SENIOR');
    srCard.classList.toggle('ring-indigo-500', effectiveLevel === 'SENIOR');

    document.getElementById('drawer-tier').textContent = DATA.tiers[String(company.tier)] || `Tier ${company.tier}`;
    document.getElementById('drawer-fit-wlb').textContent = `${company.overlap}/10 Stack Overlap • ${company.wlb}`;
    document.getElementById('drawer-interview').textContent = company.interview;
    document.getElementById('drawer-notes').textContent = company.stackNote;

    // Generate & populate Mid + Senior bullets
    const { midBullets, seniorBullets } = generateTailoredBullets(company);
    document.getElementById('drawer-pitch-mid-list').innerHTML = midBullets
      .map((b) => `<li>${escapeHtml(b)}</li>`)
      .join('');
    document.getElementById('drawer-pitch-senior-list').innerHTML = seniorBullets
      .map((b) => `<li>${escapeHtml(b)}</li>`)
      .join('');

    // Live research links
    const cleanQueryName = company.name.replace(/\(.*?\)/g, '').trim();
    const encodedAndroid = encodeURIComponent(`"${cleanQueryName}" Android`);
    const encodedCompany = encodeURIComponent(cleanQueryName);
    document.getElementById('link-linkedin').href = `https://www.linkedin.com/jobs/search/?keywords=${encodedAndroid}&location=United%20States`;
    document.getElementById('link-levels').href = `https://www.levels.fyi/t/software-engineer/focus/android?search=${encodedCompany}`;
    document.getElementById('link-blind').href = `https://www.teamblind.com/search/${encodedAndroid}`;
    document.getElementById('link-glassdoor').href = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodedAndroid}`;
    const careersLink = document.getElementById('link-careers');
    if (careersLink) {
      careersLink.href = `https://www.google.com/search?q=${encodeURIComponent(`"${cleanQueryName}" careers Android engineer`)}`;
    }

    // Populate CRM form fields
    document.getElementById('drawer-crm-status').value = crm.status;
    document.getElementById('drawer-crm-level').value = crm.targetLevel || 'Auto';
    document.getElementById('drawer-crm-contact').value = crm.contact || '';
    document.getElementById('drawer-crm-notes').value = crm.notes || '';
    const followUpInput = document.getElementById('drawer-crm-followup');
    if (followUpInput) followUpInput.value = crm.followUp;
    renderDrawerStageHistory(crm);

    const backdrop = document.getElementById('drawer-backdrop');
    const drawer = document.getElementById('detail-drawer');
    const wasClosed = drawer.classList.contains('translate-x-full');
    clearTimeout(drawerCloseTimer);
    drawer.inert = false;
    backdrop.classList.remove('hidden');
    if (wasClosed) {
      lastFocusedBeforeDrawer = document.activeElement;
      document.getElementById('btn-close-drawer')?.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => {
      backdrop.classList.remove('opacity-0');
      backdrop.classList.add('opacity-100');
      drawer.classList.remove('translate-x-full');
    });
  }

  let lastFocusedBeforeDrawer = null;

  function renderDrawerStageHistory(crm) {
    const el = document.getElementById('drawer-stage-history');
    if (!el) return;
    const entries = DATA.pipelineStages
      .filter((s) => crm.stageDates[s.id])
      .map((s) => `${escapeHtml(s.label)} ${escapeHtml(formatShortDate(crm.stageDates[s.id]))}`);
    el.innerHTML = entries.length ? `Stage history: ${entries.join(' → ')}` : '';
    el.classList.toggle('hidden', entries.length === 0);
  }

  let drawerCloseTimer = null;
  function closeDrawer() {
    const backdrop = document.getElementById('drawer-backdrop');
    const drawer = document.getElementById('detail-drawer');
    if (!drawer || drawer.classList.contains('translate-x-full')) return;

    drawer.classList.add('translate-x-full');
    drawer.inert = true; // keep off-screen inputs out of the Tab order
    backdrop.classList.remove('opacity-100');
    backdrop.classList.add('opacity-0');
    clearTimeout(drawerCloseTimer);
    drawerCloseTimer = setTimeout(() => {
      backdrop.classList.add('hidden');
      state.activeDrawerCompanyId = null;
    }, 220);
    // Return focus to the row that opened the drawer; rows may have been re-rendered,
    // so fall back to the visible row/card for the same company.
    const cid = state.activeDrawerCompanyId;
    const target = lastFocusedBeforeDrawer?.isConnected
      ? lastFocusedBeforeDrawer
      : Array.from(document.querySelectorAll(`[data-company-id="${cid}"]`)).find((el) => el.offsetParent !== null);
    target?.focus({ preventScroll: true });
    lastFocusedBeforeDrawer = null;
  }

  function flashDrawerSaved() {
    const ind = document.getElementById('drawer-saved-indicator');
    if (!ind) return;
    ind.classList.remove('opacity-0');
    ind.classList.add('opacity-100');
    setTimeout(() => {
      ind.classList.remove('opacity-100');
      ind.classList.add('opacity-0');
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Exports (Markdown Clipboard, Obsidian YAML .md, CSV, JSON CRM Backup)
  // ---------------------------------------------------------------------------
  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function copyFilteredMarkdown() {
    const list = getFilteredAndSortedCompanies();
    const header = [
      `# 2027 U.S. Android Engineering Targets (${list.length} Companies)`,
      '',
      '| Rank | Company | Tier | HQ / Hubs | Band | Mid TC | Senior TC | WFA | Level Fit | CRM Status | Stack & Interview |',
      '|---|---|---|---|---|---|---|---|---|---|---|'
    ];
    const rows = list.map((c) => {
      const crm = getCrmRecord(c.id);
      return `| #${c.id} | ${mdCell(c.name)} | T${c.tier} | ${mdCell(c.hq)} | ${c.band} | ${c.midTc} | ${c.seniorTc} | ${c.wfa} | ${c.levelFit} | ${crm.status} | ${mdCell(`${c.interview} — ${c.stackNote}`)} |`;
    });

    const md = header.concat(rows).join('\n');
    copyToClipboard(md, `Copied ${list.length} companies as Markdown table!`);
  }

  function exportObsidianMarkdown() {
    const list = getFilteredAndSortedCompanies();
    const today = new Date().toISOString().slice(0, 10);

    const lines = [
      '---',
      `title: "2027 Android Engineering Target Matrix"`,
      `date: ${today}`,
      `tags: [career-2027, android-engineering, job-search, aosp, jetpack-compose]`,
      `total_targets: ${list.length}`,
      `career_mode: "${state.careerMode}"`,
      `metro_filter: "${state.filters.metro}"`,
      `band_filter: "${state.filters.band}"`,
      `wfa_filter: "${state.filters.wfa}"`,
      '---',
      '',
      `# 2027 U.S. Android Engineering Target Matrix (${list.length} Companies)`,
      '',
      `> Generated from **2027 U.S. Android Engineering Career & Job-Hop Command Center** on ${today}.`,
      '',
      '## Target Matrix',
      '',
      '| Rank | Company | Tier | HQ & Metros | Band | Mid TC (SWE II) | Senior TC (L5) | WFA Policy | WLB | Level Fit | CRM Stage | Interview & Stack |',
      '| :--- | :--- | :--- | :--- | :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
    ];

    list.forEach((c) => {
      const crm = getCrmRecord(c.id);
      const noteText = crm.notes.trim() ? ` **(Note: ${mdCell(crm.notes.trim())})**` : '';
      lines.push(
        `| #${c.id} | **${mdCell(c.name)}** | T${c.tier} | ${mdCell(`${c.hq} (${c.metros.join(', ')})`)} | ${c.band} | ${c.midTc} | ${c.seniorTc} | ${c.wfa} | ${c.wlb} | ${c.levelFit} | ${crm.status} | ${mdCell(`${c.interview}: ${c.stackNote}`)}${noteText} |`
      );
    });

    // Append active CRM dossier section if any targets have notes or active status
    const activeDossiers = list.filter((c) => {
      const crm = getCrmRecord(c.id);
      return crm.status !== 'Unreviewed' || crm.contact.trim() || crm.notes.trim() || crm.followUp;
    });

    if (activeDossiers.length > 0) {
      lines.push('', '## Active CRM Dossiers & Contacts', '');
      activeDossiers.forEach((c) => {
        const crm = getCrmRecord(c.id);
        lines.push(`### #${c.id} ${c.name} (${crm.status})`);
        lines.push(`- **Comp:** Mid ${c.midTc} | Senior ${c.seniorTc} (Band ${c.band})`);
        lines.push(`- **Policy & Loop:** ${c.wfa} | ${c.wlb} | ${c.interview}`);
        if (crm.contact) lines.push(`- **Contact / Referral:** ${crm.contact}`);
        if (crm.followUp) lines.push(`- **Next Follow-up:** ${crm.followUp}`);
        const history = DATA.pipelineStages
          .filter((s) => crm.stageDates[s.id])
          .map((s) => `${s.label} ${crm.stageDates[s.id].slice(0, 10)}`);
        if (history.length) lines.push(`- **Stage History:** ${history.join(' → ')}`);
        if (crm.notes) lines.push(`- **Prep Notes:** ${crm.notes}`);
        lines.push('');
      });
    }

    downloadFile(`2027-Android-Targets-Obsidian-${today}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    showToast(`Exported Obsidian note with ${list.length} targets!`);
  }

  function exportCsv() {
    const list = getFilteredAndSortedCompanies();
    const escCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

    const headers = [
      'Rank',
      'Company',
      'Tier',
      'Tier_Name',
      'HQ',
      'Metros',
      'Stage',
      'Band',
      'Mid_TC',
      'Senior_TC',
      'Stack_Overlap',
      'WFA_Policy',
      'WLB',
      'Interview_Loop',
      'Level_Fit',
      'Status_Flag',
      'CRM_Stage',
      'Target_Level',
      'Contact',
      'Notes',
      'Follow_Up',
      'Stage_History',
      'Stack_Summary'
    ];

    const rows = [headers.map(escCsv).join(',')];
    list.forEach((c) => {
      const crm = getCrmRecord(c.id);
      rows.push(
        [
          c.id,
          c.name,
          c.tier,
          DATA.tiers[String(c.tier)] || '',
          c.hq,
          c.metros.join('; '),
          c.stage,
          c.band,
          c.midTc,
          c.seniorTc,
          c.overlap,
          c.wfa,
          c.wlb,
          c.interview,
          c.levelFit,
          c.statusFlag,
          crm.status,
          crm.targetLevel,
          crm.contact,
          crm.notes,
          crm.followUp,
          DATA.pipelineStages
            .filter((s) => crm.stageDates[s.id])
            .map((s) => `${s.label} ${crm.stageDates[s.id].slice(0, 10)}`)
            .join(' > '),
          c.stackNote
        ]
          .map(escCsv)
          .join(',')
      );
    });

    const today = new Date().toISOString().slice(0, 10);
    // BOM so Excel on Windows reads UTF-8 (en-dashes in "$115k–$145k") correctly.
    downloadFile(`2027-Android-Companies-${today}.csv`, '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
    showToast(`Exported ${list.length} rows to CSV!`);
  }

  function exportJsonBackup() {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: DATA.version,
      crm: state.crm,
      seniorChecks: state.seniorChecks
    };
    const today = new Date().toISOString().slice(0, 10);
    downloadFile(`2027-Android-CRM-Backup-${today}.json`, JSON.stringify(payload, null, 2), 'application/json');
    showToast('Downloaded JSON CRM & Senior Readiness backup!');
  }

  function handleJsonImport(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!isPlainObject(parsed) || (!isPlainObject(parsed.crm) && !isPlainObject(parsed.seniorChecks))) {
          showToast('Not a Command Center backup (missing "crm" / "seniorChecks").');
          return;
        }
        if (isPlainObject(parsed.crm)) {
          state.crm = Object.fromEntries(
            Object.entries(parsed.crm).filter(([, rec]) => isPlainObject(rec))
          );
          saveJsonStorage(STORAGE_KEYS.CRM, state.crm);
        }
        if (isPlainObject(parsed.seniorChecks)) {
          state.seniorChecks = parsed.seniorChecks;
          saveJsonStorage(STORAGE_KEYS.SENIOR_CHECKS, state.seniorChecks);
        }
        renderSeniorChecklist();
        refreshAll();
        showToast('Successfully restored CRM pipeline & checklist from JSON backup!');
      } catch (err) {
        showToast('Invalid JSON backup file.');
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------
  function setCareerMode(mode) {
    state.careerMode = mode;
    document.querySelectorAll('.level-btn').forEach((btn) => {
      const active = btn.dataset.level === mode;
      btn.className = `level-btn px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
        active
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
      }`;
    });
    updateSortDescription(); // "Highest Comp" wording depends on career mode
    refreshAll();
    if (state.activeDrawerCompanyId) {
      openDrawer(state.activeDrawerCompanyId);
    }
  }

  function setSortMode(mode) {
    state.sortMode = mode;
    document.querySelectorAll('.sort-pill').forEach((btn) => {
      const active = btn.dataset.sort === mode;
      btn.className = `sort-pill px-3.5 py-2 rounded-xl text-xs font-semibold transition inline-flex items-center gap-1.5 ${
        active
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
      }`;
    });

    const compPanel = document.getElementById('composite-panel');
    if (compPanel) compPanel.classList.toggle('hidden', mode !== 'composite');

    updateSortDescription();
    state.currentPage = 1;
    refreshAll();
  }

  function updateSortDescription() {
    const payLabel =
      state.careerMode === 'SENIOR' ? 'Senior (L5)' : state.careerMode === 'MID' ? 'Mid-Level (L4)' : 'blended Mid + Senior';
    const descMap = {
      master: `Ordered by hardware/OS stack proximity to Johnson Health Tech (#1 → #${DATA.companies.length})`,
      composite: 'Ranked dynamically by your custom 5-factor weighted composite score (0–100)',
      pay: `Sorted by highest estimated ${payLabel} Total Compensation`,
      fit: 'Sorted by architectural & hardware/OS stack overlap with JHT commercial consoles',
      wlb: 'Sorted by verified Work-Life Balance profile and sustainable engineering pace',
      pipeline: 'Grouped by active CRM application stage (Offer → Shortlisted first)'
    };
    const descEl = document.getElementById('sort-description');
    if (descEl) descEl.textContent = descMap[state.sortMode] || '';
  }

  function applyWeightSliders(fit, pay, wlb, lvl, wfa) {
    state.weights = { fit, pay, wlb, lvl, wfa };
    const map = { fit, pay, wlb, lvl, wfa };
    Object.entries(map).forEach(([k, val]) => {
      const slider = document.getElementById(`slider-${k}`);
      const valEl = document.getElementById(`val-w-${k}`);
      const lblEl = document.getElementById(`lbl-w-${k}`);
      if (slider) slider.value = val;
      if (valEl) valEl.textContent = `${val}%`;
      if (lblEl) lblEl.textContent = val;
    });
    if (state.sortMode === 'composite') {
      refreshAll();
    }
  }

  function resetAllFilters() {
    state.filters = { ...DEFAULT_FILTERS };
    state.currentPage = 1;

    document.getElementById('search-input').value = '';
    document.getElementById('filter-tier').value = 'ALL';
    document.getElementById('filter-wfa').value = 'ALL';
    document.getElementById('filter-interview').value = 'ALL';
    document.getElementById('filter-wlb').value = 'ALL';

    syncPillButtons();
    refreshAll();
    showToast('Reset all filters.');
  }

  // Active styles use Tailwind's "!" (important) modifier so they beat the
  // pills' own dark:bg-* / dark:text-* classes, which otherwise win in dark mode.
  const ACTIVE_INDIGO = ['!bg-indigo-600', '!text-white', '!border-indigo-600'];
  const ACTIVE_ROSE = ['!bg-rose-600', '!text-white', '!border-rose-600'];
  const ACTIVE_AMBER = ['!bg-amber-500', '!text-white', '!border-amber-500'];

  function setPillActive(btn, active, classes = ACTIVE_INDIGO) {
    classes.forEach((cls) => btn.classList.toggle(cls, active));
    btn.setAttribute('aria-pressed', String(active));
  }

  function syncPillButtons() {
    document.querySelectorAll('.band-pill').forEach((btn) => {
      setPillActive(btn, btn.dataset.band === state.filters.band);
    });

    document.querySelectorAll('.levelfit-pill').forEach((btn) => {
      setPillActive(btn, btn.dataset.levelfit === state.filters.levelFit);
    });

    const yoeBtn = document.getElementById('toggle-realistic-yoe');
    if (yoeBtn) setPillActive(yoeBtn, state.filters.realisticYoeOnly);

    const wlBtn = document.getElementById('toggle-hide-watchlist');
    if (wlBtn) setPillActive(wlBtn, state.filters.hideWatchlist, ACTIVE_ROSE);

    const fuBtn = document.getElementById('toggle-followup-due');
    if (fuBtn) setPillActive(fuBtn, state.filters.followUpDue, ACTIVE_AMBER);
  }

  function renderStaticCounts() {
    const total = DATA.companies.length;
    const watchCount = DATA.companies.filter((c) => c.statusFlag !== 'Active').length;
    document.querySelectorAll('[data-total-count]').forEach((el) => {
      el.textContent = total;
    });
    const wlCount = document.getElementById('watchlist-count');
    if (wlCount) wlCount.textContent = watchCount;
    const starterCount = document.getElementById('starter-count');
    if (starterCount) starterCount.textContent = (DATA.starterTargetIds || []).length;
  }

  function bindEvents() {
    // Theme toggle (initial theme is applied by an inline <head> script to avoid a flash)
    document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      try {
        localStorage.setItem(STORAGE_KEYS.THEME, isDark ? 'dark' : 'light');
      } catch (err) {
        console.warn('Theme preference not saved', err);
      }
    });

    // Global career level buttons
    document.querySelectorAll('.level-btn').forEach((btn) => {
      btn.addEventListener('click', () => setCareerMode(btn.dataset.level));
    });

    // Quick Senior Stretch activation inside Strategy panel
    document.getElementById('btn-quick-senior-mode')?.addEventListener('click', () => {
      setCareerMode('SENIOR');
      applyWeightSliders(35, 20, 5, 35, 5);
      setSortMode('composite');
      showToast('Switched to Senior Stretch (SWE III / L5) scoring & comp view!');
    });

    // Collapsible panels
    document.getElementById('btn-toggle-strategy')?.addEventListener('click', () => {
      document.getElementById('panel-strategy')?.classList.toggle('hidden');
    });
    document.getElementById('btn-toggle-metros')?.addEventListener('click', () => {
      document.getElementById('panel-metros')?.classList.toggle('hidden');
    });
    document.querySelectorAll('[data-close-panel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.closePanel)?.classList.add('hidden');
      });
    });

    // Senior readiness checklist
    document.getElementById('senior-checklist-container')?.addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-check-id]');
      if (!cb) return;
      state.seniorChecks[cb.dataset.checkId] = cb.checked;
      saveJsonStorage(STORAGE_KEYS.SENIOR_CHECKS, state.seniorChecks);
      renderSeniorChecklist();
    });

    // Sort pills
    document.querySelectorAll('.sort-pill').forEach((btn) => {
      btn.addEventListener('click', () => setSortMode(btn.dataset.sort));
    });

    // Weight sliders & presets
    ['fit', 'pay', 'wlb', 'lvl', 'wfa'].forEach((k) => {
      document.getElementById(`slider-${k}`)?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        applyWeightSliders(
          k === 'fit' ? val : state.weights.fit,
          k === 'pay' ? val : state.weights.pay,
          k === 'wlb' ? val : state.weights.wlb,
          k === 'lvl' ? val : state.weights.lvl,
          k === 'wfa' ? val : state.weights.wfa
        );
      });
    });

    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const parts = btn.dataset.preset.split(',').map((n) => parseInt(n, 10));
        applyWeightSliders(parts[0], parts[1], parts[2], parts[3], parts[4]);
        showToast(`Applied "${btn.textContent.trim()}" weights`);
      });
    });

    // Delegated clicks on Pipeline Funnel, Metro Pills, Metro Cards, Pagination, and Company Rows
    document.addEventListener('click', (e) => {
      const stageBtn = e.target.closest('.stage-pill');
      if (stageBtn) {
        state.filters.pipelineStage = stageBtn.dataset.stage;
        state.currentPage = 1;
        refreshAll();
        return;
      }

      const metroBtn = e.target.closest('.metro-pill');
      if (metroBtn) {
        state.filters.metro = metroBtn.dataset.metro;
        state.currentPage = 1;
        refreshAll();
        return;
      }

      const metroCard = e.target.closest('[data-metro-card]');
      if (metroCard) {
        const targetMetro = metroCard.dataset.metroCard;
        state.filters.metro = state.filters.metro === targetMetro ? 'ALL' : targetMetro;
        state.currentPage = 1;
        refreshAll();
        return;
      }

      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn && !pageBtn.disabled) {
        state.currentPage = parseInt(pageBtn.dataset.page, 10);
        refreshAll();
        return;
      }

      const row = e.target.closest('[data-company-id]');
      if (row) {
        openDrawer(parseInt(row.dataset.companyId, 10));
      }
    });

    // Delegated change on inline CRM status dropdowns
    document.addEventListener('change', (e) => {
      const rowSelect = e.target.closest('[data-crm-row-select]');
      if (rowSelect) {
        const cid = parseInt(rowSelect.dataset.crmRowSelect, 10);
        updateCrmRecord(cid, { status: rowSelect.value });
        refreshAll();
        showToast(`Updated #${cid} → ${rowSelect.value}`);
      }
    });

    // Band pills
    document.querySelectorAll('.band-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filters.band = btn.dataset.band;
        state.currentPage = 1;
        syncPillButtons();
        refreshAll();
      });
    });

    // LevelFit pills
    document.querySelectorAll('.levelfit-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filters.levelFit = btn.dataset.levelfit;
        state.currentPage = 1;
        syncPillButtons();
        refreshAll();
      });
    });

    // Search & dropdown filters
    document.getElementById('search-input')?.addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      state.currentPage = 1;
      refreshAll();
    });

    document.getElementById('btn-clear-search')?.addEventListener('click', () => {
      const inp = document.getElementById('search-input');
      if (inp) inp.value = '';
      state.filters.search = '';
      state.currentPage = 1;
      refreshAll();
    });

    document.getElementById('filter-tier')?.addEventListener('change', (e) => {
      state.filters.tier = e.target.value;
      state.currentPage = 1;
      refreshAll();
    });

    document.getElementById('filter-wfa')?.addEventListener('change', (e) => {
      state.filters.wfa = e.target.value;
      state.currentPage = 1;
      refreshAll();
    });

    document.getElementById('filter-interview')?.addEventListener('change', (e) => {
      state.filters.interview = e.target.value;
      state.currentPage = 1;
      refreshAll();
    });

    document.getElementById('filter-wlb')?.addEventListener('change', (e) => {
      state.filters.wlb = e.target.value;
      state.currentPage = 1;
      refreshAll();
    });

    // Quick boolean filter toggles
    document.getElementById('toggle-realistic-yoe')?.addEventListener('click', () => {
      state.filters.realisticYoeOnly = !state.filters.realisticYoeOnly;
      state.currentPage = 1;
      syncPillButtons();
      refreshAll();
    });

    document.getElementById('toggle-followup-due')?.addEventListener('click', () => {
      state.filters.followUpDue = !state.filters.followUpDue;
      state.currentPage = 1;
      syncPillButtons();
      refreshAll();
    });

    document.getElementById('toggle-hide-watchlist')?.addEventListener('click', () => {
      state.filters.hideWatchlist = !state.filters.hideWatchlist;
      state.currentPage = 1;
      syncPillButtons();
      refreshAll();
    });

    document.getElementById('btn-reset-filters')?.addEventListener('click', resetAllFilters);
    document.getElementById('btn-empty-reset')?.addEventListener('click', resetAllFilters);

    // Show All / Paginate toggle
    document.getElementById('btn-toggle-show-all')?.addEventListener('click', () => {
      state.showAll = !state.showAll;
      state.currentPage = 1;
      refreshAll();
    });

    // CRM Starter Targets, Backup, Import, Clear
    document.getElementById('btn-load-starter')?.addEventListener('click', () => {
      let added = 0;
      (DATA.starterTargetIds || []).forEach((id) => {
        const cur = getCrmRecord(id);
        if (cur.status === 'Unreviewed') {
          updateCrmRecord(id, { status: 'Shortlisted' });
          added++;
        }
      });
      refreshAll();
      showToast(
        added > 0
          ? `Shortlisted ${added} high-ROI 2027 targets!`
          : `All ${(DATA.starterTargetIds || []).length} starter targets are already in your pipeline.`
      );
    });

    document.getElementById('btn-export-json')?.addEventListener('click', exportJsonBackup);
    document.getElementById('btn-import-json')?.addEventListener('click', () => {
      document.getElementById('input-import-json')?.click();
    });
    document.getElementById('input-import-json')?.addEventListener('change', (e) => {
      handleJsonImport(e.target.files?.[0]);
      e.target.value = '';
    });

    document.getElementById('btn-clear-pipeline')?.addEventListener('click', () => {
      if (Object.keys(state.crm).length === 0) {
        showToast('Pipeline is already empty.');
        return;
      }
      if (confirm('Clear all saved pipeline stages, contacts, and notes?')) {
        state.crm = {};
        saveJsonStorage(STORAGE_KEYS.CRM, state.crm);
        refreshAll();
        showToast('Cleared CRM pipeline.');
      }
    });

    // Exports
    document.getElementById('btn-copy-md')?.addEventListener('click', copyFilteredMarkdown);
    document.getElementById('btn-export-obsidian')?.addEventListener('click', exportObsidianMarkdown);
    document.getElementById('btn-export-csv')?.addEventListener('click', exportCsv);

    // Drawer controls & auto-save
    document.getElementById('btn-close-drawer')?.addEventListener('click', closeDrawer);
    document.getElementById('drawer-backdrop')?.addEventListener('click', closeDrawer);

    document.getElementById('drawer-crm-status')?.addEventListener('change', (e) => {
      if (!state.activeDrawerCompanyId) return;
      updateCrmRecord(state.activeDrawerCompanyId, { status: e.target.value });
      renderDrawerStageHistory(getCrmRecord(state.activeDrawerCompanyId));
      flashDrawerSaved();
      refreshAll();
    });

    document.getElementById('drawer-crm-level')?.addEventListener('change', (e) => {
      if (!state.activeDrawerCompanyId) return;
      updateCrmRecord(state.activeDrawerCompanyId, { targetLevel: e.target.value });
      openDrawer(state.activeDrawerCompanyId); // re-highlight the Mid / Senior comp card
      flashDrawerSaved();
      refreshAll();
    });

    document.getElementById('drawer-crm-contact')?.addEventListener('input', (e) => {
      if (!state.activeDrawerCompanyId) return;
      updateCrmRecord(state.activeDrawerCompanyId, { contact: e.target.value });
      flashDrawerSaved();
    });

    document.getElementById('drawer-crm-followup')?.addEventListener('change', (e) => {
      if (!state.activeDrawerCompanyId) return;
      updateCrmRecord(state.activeDrawerCompanyId, { followUp: e.target.value });
      flashDrawerSaved();
      refreshAll();
    });

    document.getElementById('drawer-crm-notes')?.addEventListener('input', (e) => {
      if (!state.activeDrawerCompanyId) return;
      updateCrmRecord(state.activeDrawerCompanyId, { notes: e.target.value });
      flashDrawerSaved();
    });

    document.getElementById('btn-copy-mid-bullets')?.addEventListener('click', () => {
      if (!state.activeDrawerCompanyId) return;
      const c = DATA.companies.find((item) => item.id === state.activeDrawerCompanyId);
      if (!c) return;
      const { midBullets } = generateTailoredBullets(c);
      copyToClipboard(midBullets.map((b) => `• ${b}`).join('\n'), 'Copied Mid-Level (SWE II) resume bullets!');
    });

    document.getElementById('btn-copy-senior-bullets')?.addEventListener('click', () => {
      if (!state.activeDrawerCompanyId) return;
      const c = DATA.companies.find((item) => item.id === state.activeDrawerCompanyId);
      if (!c) return;
      const { seniorBullets } = generateTailoredBullets(c);
      copyToClipboard(seniorBullets.map((b) => `• ${b}`).join('\n'), 'Copied Senior (SWE III / L5) resume bullets!');
    });

    // Keyboard shortcuts: '/' to focus search, 'Esc' to close drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
      } else if (e.key === 'Enter' && e.target.matches?.('[data-company-id]')) {
        openDrawer(parseInt(e.target.dataset.companyId, 10));
      } else if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA' &&
        document.activeElement?.tagName !== 'SELECT'
      ) {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  restoreViewState();
  renderStaticCounts();
  renderStaticDropdowns();
  renderSeniorChecklist();
  bindEvents();
  syncControlsToState(); // syncs pills/sliders/selects and renders

})();

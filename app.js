// =====================================================
// GLOBALS
// =====================================================
let pcsUnsub = null;
let commandsUnsub = null;
let currentAdminProfile = null;
let loginProgressToast = null;
let loginInProgress = false;   // ✅ ADD THIS
let EXPECTED_AGENT_VERSION = null;

fetch("/version.json")
  .then(r => r.json())
  .then(v => {
    EXPECTED_AGENT_VERSION = v.version;
  })
  .catch(() => {});
// =====================================================
// MULTI-TENANT CONFIG
// =====================================================
const COMPANY_ID = "mlsn_internal";

function companyPcsRef() {
  return db
    .collection("companies")
    .doc(COMPANY_ID)
    .collection("pcs");
}
// =====================================================
// UI CONSTANTS
// =====================================================
const CARD_STYLE = `
  border-radius: 12px;
  padding: 14px 16px;
  margin: 10px 0;
  background: var(--card-elevated);
  box-shadow: 0 6px 16px rgba(0,0,0,0.25);
  transition: box-shadow .15s ease, transform .12s ease;
`;
// ============================
// UI STATE (collapsed cards)
// ============================
const collapsedPCs = new Set();
const pendingCommands = new Set();
const commandCooldowns = new Map();
// ============================
// PC HEALTH RESOLVER (single source of truth)
// ============================
// ============================
// RETENTION POLICY
// ============================
const SESSION_RETENTION_DAYS = 7;
const HISTORY_RETENTION_DAYS = 30;
const auditVerificationCache = new Map();
let pcsInitialized = false;

document.addEventListener("DOMContentLoaded", () => {
  const isDark = localStorage.getItem("darkMode") === "1";
  document.body.classList.toggle("dark", isDark);
  updateThemeIcon();
});
function updateThemeIcon() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const isDark = document.body.classList.contains("dark");
  btn.textContent = isDark ? "☀" : "🌙";
}

function getPcHealth(pc) {
  const now = Date.now();
  const lastSeen = pc.agentAliveAt?.toMillis?.();

  // 1️⃣ Never reported
  if (!lastSeen) {
    return {
      status: "OFFLINE",
      color: "red",
      reason: "never reported"
    };
  }

  const ageSec = Math.floor((now - lastSeen) / 1000);

  // 2️⃣ Agent version missing (legacy or broken agent)
  if (!pc.agentVersion) {
    return {
      status: "STALE",
      color: "orange",
      reason: "agent version missing"
    };
  }

  // 3️⃣ Agent outdated (future-proofing)
    if (
    EXPECTED_AGENT_VERSION &&
    pc.agentVersion &&
    pc.agentVersion !== EXPECTED_AGENT_VERSION
  ) {
    return {
      status: "STALE",
      color: "orange",
      reason: `agent mismatch (${pc.agentVersion})`
    };
  }

  // 4️⃣ Healthy heartbeat
  if (ageSec < 90) {
    return {
      status: "ONLINE",
      color: "green"
    };
  }

  // 5️⃣ Late heartbeat
  if (ageSec < 300) {
    return {
      status: "STALE",
      color: "orange",
      reason: `heartbeat delayed (${ageSec}s)`
    };
  }

  // 6️⃣ Dead
  return {
    status: "OFFLINE",
    color: "red",
    reason: `no heartbeat (${ageSec}s)`
  };
}

function hasTrustedAudit(pc) {
  if (!pc.audit) return false;

  const now = Date.now();
  const last = pc.audit.lastEventAt * 1000;

  // audit must be recent (within 5 minutes)
  return (now - last) < 5 * 60 * 1000;
}

function getAuditStatus(pc) {
  if (!pc.audit || !pc.audit.lastEventAt) {
    return {
      state: "MISSING",
      color: "#9e9e9e",
      bg: "#f5f5f5",
      label: "No local audit"
    };
  }

  const ageSec = Math.floor(
    (Date.now() - pc.audit.lastEventAt * 1000) / 1000
  );

  if (ageSec <= 30) {
    return {
      state: "FRESH",
      color: "#2e7d32",
      bg: "#e8f5e9",
      label: "Verified by local audit"
    };
  }

  return {
    state: "STALE",
    color: "#9e9e9e",
    bg: "#eeeeee",
    label: `Audit stale (${ageSec}s ago)`
  };
}

// =====================================================
// TOASTS
// =====================================================
function toast(message, type = "info", timeout = 2500) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;

  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

function showProgressToast(message, icon = "spinner") {
  const container = document.getElementById("toast-container");
  if (!container) return null;

  const el = document.createElement("div");
        el.className = "toast info";
        el.style.opacity = "1";   // ✅ force visible instantly

  el.innerHTML = `
    <span class="toast-icon ${icon === "spinner" ? "spinner" : ""}">
      ${icon === "spinner" ? "" : icon}
    </span>
    <span class="toast-text">${message}</span>
  `;

  container.appendChild(el);
  return el;
}

function updateProgressToast(el, type, message) {
  if (!el) return;

  el.className = `toast ${type}`;

  const text = el.querySelector(".toast-text");
  if (text) text.textContent = message;

  const duration =
  type === "success" ? 4500 :
  type === "error"   ? 5000 :
  3500;

  setTimeout(() => {
  el.style.opacity = "0";
  el.style.transform = "translateY(6px)";
  setTimeout(() => el.remove(), 300);
}, duration);
}

// =====================================================
// AUTH
// =====================================================
function login() {

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const btn = document.getElementById("login-btn");
  const status = document.getElementById("login-status");

  if (!email || !password) {

    toast("⚠ Enter email and password", "warn");

    status.textContent = "Enter email and password";
    status.style.color = "#c62828";

    return;
  }

  btn.disabled = true;
  status.textContent = "Authenticating...";
  status.style.color = "var(--muted)";

  loginInProgress = true;

  loginProgressToast = showProgressToast(
    "Signing in...",
    "spinner"
  );

  auth.signInWithEmailAndPassword(email, password)

    .catch(err => {

      loginInProgress = false;

      let msg = "Incorrect email or password";

      if (err.code === "auth/invalid-email")
        msg = "Invalid email format";

      if (err.code === "auth/too-many-requests")
        msg = "Too many attempts. Try again later.";

      updateProgressToast(
        loginProgressToast,
        "error",
        msg
      );

      document.getElementById("password").value = "";

      status.textContent = msg;
      status.style.color = "#c62828";

    })

    .finally(() => {

      btn.disabled = false;

    });

}

function logout() {
  confirmToastInline(
    "Log out of admin session?",
    {
      tone: "warn",
      confirmText: "Logout",
      onConfirm: async () => {

        const email = document.getElementById("email");
        const password = document.getElementById("password");

        if (email) email.value = "";
        if (password) password.value = "";

        if (pcsUnsub) {
          pcsUnsub();
          pcsUnsub = null;
          pcsInitialized = false;
        }

        if (commandsUnsub) {
          commandsUnsub();
          commandsUnsub = null;
        }

        await auth.signOut();
      }
    }
  );
}

// Debug version of resetPassword — drop in and redeploy (or test in console)
function resetPassword() {
  const email = document.getElementById("email").value.trim();
  const btn = document.getElementById("forgot-btn");
  const status = document.getElementById("reset-status");

  if (!email) {
    toast("⚠ Enter your email first", "warn");
    status.textContent = "Enter your email first";
    status.style.color = "#c62828";
    return;
  }

  btn.disabled = true;
  status.textContent = "Sending reset email...";
  status.style.color = "var(--muted)";

  const pending = showProgressToast(
    "Sending password reset email...",
    "spinner"
  );

  auth.sendPasswordResetEmail(email)
    .then(() => {

      updateProgressToast(
        pending,
        "success",
        "Reset email sent"
      );

      status.textContent =
        "✔ Reset link sent. Check your inbox.";
      status.style.color = "#2e7d32";

    })
    .catch((error) => {

      updateProgressToast(
        pending,
        "error",
        error.message
      );

      status.textContent = error.message;
      status.style.color = "#c62828";

    })
    .finally(() => {
      btn.disabled = false;
    });
}

// =====================================================
// SUMMARY + SEARCH
// =====================================================
const summaryDiv = document.getElementById("summary");
const searchInput = document.getElementById("search");
const pcsDiv = document.getElementById("pcs");

function renderSummary(pcs) {
  let online = 0, stale = 0, offline = 0;

  pcs.forEach(pc => {
    const health = getPcHealth(pc);

    if (health.status === "ONLINE") online++;
    else if (health.status === "STALE") stale++;
    else offline++;
  });


  summaryDiv.innerHTML = `
  <div class="status-bar">
    <div class="status-pill">
      <span class="status-dot" style="background:#2e7d32"></span>
      ONLINE: ${online}
    </div>

    <div class="status-pill">
      <span class="status-dot" style="background:#ef6c00"></span>
      STALE: ${stale}
    </div>

    <div class="status-pill">
      <span class="status-dot" style="background:#c62828"></span>
      OFFLINE: ${offline}
    </div>
  </div>
`;
}

function matchesSearch(pc) {
  const q = searchInput.value.toLowerCase();
  if (!q) return true;

  return (
    (pc.displayName || "").toLowerCase().includes(q) ||
    (pc.hostname || "").toLowerCase().includes(q) ||
    pc.id.toLowerCase().includes(q)
  );
}

// =====================================================
// AUTH STATE (FIXED & CLEAN)
// =====================================================
auth.onAuthStateChanged(async user => {
  const loginPanel = document.getElementById("login-panel");
  const dashboard  = document.getElementById("dashboard");
  const logoutBtn  = document.getElementById("logout-btn");

  // ===== LOGGED OUT =====
if (!user) {

  loginPanel.hidden = false;
  dashboard.hidden  = true;
  document.body.classList.remove("auth-loading");

  if (logoutBtn) {
    logoutBtn.hidden = true;
    logoutBtn.style.display = "none";
  }

  // Clear admin label
  const emailLabel = document.getElementById("admin-email");
  if (emailLabel) emailLabel.textContent = "";

  // Clear login messages
  const loginStatus = document.getElementById("login-status");
  if (loginStatus) loginStatus.textContent = "";

  const resetStatus = document.getElementById("reset-status");
  if (resetStatus) resetStatus.textContent = "";

  return;
}

  // ===== ADMIN CHECK =====
  const adminDoc = await db.collection("admins").doc(user.uid).get();
  if (!adminDoc.exists) {
    alert("Not an admin");
    await auth.signOut();
    return;
  }

  currentAdminProfile = adminDoc.data();

  if (loginInProgress && loginProgressToast) {

  const name =
    currentAdminProfile?.displayName ||
    auth.currentUser.email.split("@")[0];

  updateProgressToast(
    loginProgressToast,
    "success",
    `Welcome back, ${name}`
  );

  loginProgressToast = null;
  loginInProgress = false;
}

  // ADD THIS BLOCK HERE
  const emailLabel = document.getElementById("admin-email");
  if (emailLabel && auth.currentUser) {
    emailLabel.textContent =
    "Signed in as " +
    (currentAdminProfile?.displayName || auth.currentUser.email);
  }

  loginPanel.hidden = true;
  dashboard.hidden  = false;

    if (logoutBtn) {
      logoutBtn.hidden = false;
      logoutBtn.style.display = "inline-flex";
    }

    document.body.classList.remove("auth-loading");

  /// =====================================================
// COMMAND FEEDBACK LISTENER (HARDENED & FIXED)
// =====================================================
if (commandsUnsub) commandsUnsub();

commandsUnsub = db.collectionGroup("commands")
  .orderBy("createdAt", "desc")
  .limit(20)
  .onSnapshot(snapshot => {

    snapshot.docChanges().forEach(change => {

      // ✅ HARDENING: ignore other companies
      if (!change.doc.ref.path.includes(`/companies/${COMPANY_ID}/`)) {
        return;
      }

      const cmd = change.doc.data();

      // status updates
      if (change.type === "modified") {

        if (cmd.status === "executed") {
          toast(`✅ ${cmd.type.toUpperCase()} executed`, "success");
        }

        if (cmd.status === "failed") {
          toast(`❌ ${cmd.type.toUpperCase()} failed`, "error", 4000);
        }

      }

      // deleted = completed
      if (change.type === "removed") {
        toast(`⚡ Command completed`, "success", 1800);
      }

    });

  }, err => {
    console.error("COMMAND LISTENER ERROR:", err);
  });

  // =====================================================
  // PCS DASHBOARD
  // =====================================================
  if (pcsUnsub) pcsUnsub();

  pcsUnsub = companyPcsRef().onSnapshot(

    async snapshot => {

      if (!pcsInitialized) {
      pcsDiv.innerHTML = "";
      pcsInitialized = true;
    }

      const pcs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

      for (const pc of pcs) {

        const existing = auditVerificationCache.get(pc.id);
        const lastEventAt = pc.audit?.lastEventAt;

        if (!pc.audit?.lines) {
          auditVerificationCache.set(pc.id, {
            valid: false,
            reason: "No audit lines",
            lastEventAt: null
          });
          continue;
        }

        if (
          existing &&
          existing.lastEventAt &&
          lastEventAt &&
          Number(existing.lastEventAt) === Number(lastEventAt)
        ) {
          continue;
        }

        const result = await verifyAuditChain(pc.audit.lines);

        auditVerificationCache.set(pc.id, {
          ...result,
          lastEventAt
        });

      }

      window._pcs = pcs;
      renderDashboard();
    },

    error => {
      console.error("PCS LISTENER ERROR:", error);
      toast("Connection lost. Retrying...", "error", 4000);
    }
  );
});

 function toggleDarkMode() {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("darkMode", isDark ? "1" : "0");
  updateThemeIcon();
}

// =====================================================
// PC CARD
// =====================================================
function renderPc(pc) {
  const now = Date.now();                         // ✅ ADD
  const ts = pc.agentAliveAt?.toMillis?.();       // ✅ ADD
  const age = ts ? (now - ts) / 1000 : Infinity;  // ✅ ADD
  const tampered = isTamperDetected(pc);
  const health = getPcHealth(pc);
  const isCoolingDown = commandCooldowns.has(pc.id);
  const disabled = (health.status !== "ONLINE" || isCoolingDown) ? "disabled" : "";
  const div = document.createElement("div");
  console.log("UI sending to PC doc ID:", pc.id);

  div.style.cssText = CARD_STYLE;
    if (!("ontouchstart" in window)) {
  div.onmouseenter = () => {
    div.style.boxShadow = "0 10px 22px rgba(0,0,0,0.35)";
  };
  div.onmouseleave = () => {
    div.style.boxShadow = "0 6px 16px rgba(0,0,0,0.25)";
  };
}


    if (health.status === "OFFLINE") {
  div.style.opacity = "0.6";
    }

  div.innerHTML = `
        <div class="pc-header"
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            cursor:pointer;
            font-weight:600;
          ">
      <span style="font-size:18px;">
        ${pc.displayName || pc.hostname || pc.id}
      </span>

   <span
      style="
        font-size:11px;
        font-weight:700;
        padding:3px 10px;
        border-radius:999px;
        color:${health.color};
        background:${health.color}15;
      "
    >
       ${health.status}
      </span>
    </div>

    <div
  class="pc-body"
  ${health.status !== "ONLINE" || collapsedPCs.has(pc.id) ? "hidden" : ""}
  style="margin-top:6px;"
>
      Last seen: ${
      age === Infinity
        ? "never"
        : age < 5
          ? "just now"
          : Math.floor(age) + "s ago"
    }<br><br>
      ${health.status !== "ONLINE" ? `
      Health detail: <i>${health.reason}</i><br><br>
    ` : ``}

      Agent build: ${pc.agentVersion || "unknown"}<br><br>

      ${(() => {
        if (tampered) {
          return `
            <div style="
              display:inline-block;
              margin:6px 0;
              padding:2px 6px;
              font-size:11px;
              border-radius:4px;
              background:#ffebee;
              color:#c62828;
              font-weight:700;
            ">
              ⚠ Tamper detected
            </div><br><br>
          `;
        }
        
        const audit = getAuditStatus(pc);
        const trusted = hasTrustedAudit(pc);
        return `
          <div
            style="
              display:inline-flex;
              align-items:center;
              gap:6px;
              margin:8px 0;
              padding:4px 10px;
              font-size:12px;
              border-radius:999px;
              background:${audit.bg};
              color:${audit.color};
              font-weight:700;
              cursor:pointer;
              box-shadow: inset 0 0 0 1px rgba(0,0,0,0.05);
            "
            onclick="openAuditViewer('${pc.id}')"
          >
            ${trusted ? "🛡" : "⚠"} ${audit.label}
          </div>
        <br><br>
        `;
      })()}

      <div style="opacity:0.85">
        <div style="display:grid;grid-template-columns:90px 1fr;row-gap:4px;font-size:13px;">
        <div style="color:#777;">Lock</div>
        <div style="font-weight:600;">
          ${pc.session?.locked ? "LOCKED" : "UNLOCKED"}
        </div>

        <div style="color:#777;">Session</div>
        <div style="font-weight:600;">
          ${pc.session?.active ? "ACTIVE" : "IDLE"}
        </div>

        <div style="color:#777;">Seconds</div>
        <div style="font-weight:600;">
          ${pc.session?.seconds ?? 0}s
        </div>
      </div><br>


        ${pc.audit ? `
          <div style="font-size:12px;color:#555;margin-top:6px;">
            🧾 Audit:
            ${pc.audit.events} events,
            last ${Math.floor((Date.now() - pc.audit.lastEventAt * 1000) / 1000)}s ago
          </div>
        ` : `
          <div style="font-size:12px;color:#999;margin-top:6px;">
            🧾 No audit data
          </div>
        `}

      <div style="
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-top:6px;
">

  <button ${disabled}
    onclick="sendCommand('${pc.id}', 'lock')"
    style="flex:1 1 45%;border:1px solid #47474774;">
    🔒 Lock
  </button>

  <button ${disabled}
    onclick="sendCommand('${pc.id}', 'unlock')"
    style="flex:1 1 45%;border:1px solid #47474774;">
    🔓 Unlock
  </button>

  <button ${disabled}
    onclick="sendCommand('${pc.id}', 'restart')"
    style="flex:1 1 45%;border:1px solid #47474774;">
    🔄 Restart
  </button>

  <button ${disabled}
    onclick="sendCommand('${pc.id}', 'shutdown')"
    style="flex:1 1 45%;border:1px solid #47474774;">
    ⏻ Shutdown
  </button>

  <button
    onclick="event.stopPropagation(); viewHistory('${pc.id}')"
    style="flex:1 1 100%;border:1px solid #47474774;">
    📜 History
  </button>

</div>
  `;

    if (health.status === "OFFLINE") {
    div.style.borderLeft = "6px solid #c62828";
  }

  if (health.status === "STALE") {
    div.style.borderLeft = "6px solid #ef6c00";
  }

  if (health.status === "ONLINE") {
    div.style.borderLeft = "6px solid #2e7d32";
  }


  const header = div.querySelector(".pc-header");
  const body = header.nextElementSibling;

  if (health.status === "ONLINE") {
    header.onclick = () => {
      const isCollapsed = !body.hidden;
      body.hidden = isCollapsed;

      if (isCollapsed) {
        collapsedPCs.add(pc.id);
      } else {
        collapsedPCs.delete(pc.id);
      }
    };
  }

  pcsDiv.appendChild(div);
}

// =====================================================
// SEND COMMAND
// =====================================================
async function sendCommand(pcId, type, confirmed = false) {
  console.log("🚀 CLICK → sendCommand called with:", pcId, type);

  if (!confirmed && ["lock", "unlock"].includes(type)) {
    return confirmToastInline(
      `${type === "lock" ? "🔒 Lock" : "🔓 Unlock"} this PC?`,
      {
        tone: "warn",
        confirmText: "Proceed",
        onConfirm: () => sendCommand(pcId, type, true)
      }
    );
  }

  if (!confirmed && ["shutdown", "restart"].includes(type)) {
    return confirmToastInline(
      `⚠ ${type.toUpperCase()} this PC?`,
      {
        tone: "danger",
        confirmText: "Confirm",
        onConfirm: () => sendCommand(pcId, type, true)
      }
    );
  }

  const key = `${pcId}:${type}`;
  if (pendingCommands.has(key)) return;
  pendingCommands.add(key);

  const commandsRef = companyPcsRef().doc(pcId).collection("commands");
const historyRef  = companyPcsRef().doc(pcId).collection("history");

// ADD THIS BLOCK HERE
try {

  const meta = await companyPcsRef()
    .doc(pcId)
    .collection("meta")
    .doc("control")
    .get();

  const last = meta.data()?.lastCommandAt?.toMillis?.();

  if (last && Date.now() - last < 5000) {
    toast("Command cooldown active", "warn");
    pendingCommands.delete(`${pcId}:${type}`);
    return;
  }

} catch(e){
  console.warn("Cooldown check skipped:", e);
}

  let createdAt = firebase.firestore.Timestamp.now();

  // ===============================
  // 1️⃣ WRITE COMMAND (PRIMARY)
  // ===============================
  try {
    await commandsRef.add({
      type,
      status: "pending",
      issuedBy: auth.currentUser.uid,
      createdAt,
      expiresAt: firebase.firestore.Timestamp.fromMillis(
        createdAt.toMillis() + 60_000
      )
    });

    commandWritten = true;
    console.log("✅ Command document created");

    console.log("🛡 Writing admin log...");

try {
  await db.collection("admin_logs").add({
    adminUid: auth.currentUser.uid,
    adminEmail: auth.currentUser.email,
    adminDisplayName:
      currentAdminProfile?.displayName || auth.currentUser.email,
    action: type,
    targetPc: pcId,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });

  console.log("🛡 Admin log written");

} catch (err) {
  console.warn("⚠ Admin log failed:", err);
}

  } catch (err) {
    console.error("❌ COMMAND WRITE FAILED:", err);

    await historyRef.add({
      type,
      status: "FAILED",
      issuedBy: auth.currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      expiresAt: firebase.firestore.Timestamp.fromMillis(
        Date.now() + HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
      )
    });

    toast("❌ Command failed to write", "error");
    pendingCommands.delete(key);
    return;
  }

  // ===============================
  // 2️⃣ UPDATE RATE LIMIT META (NON-FATAL)
  // ===============================
  try {
    await companyPcsRef()
      .doc(pcId)
      .collection("meta")
      .doc("control")
      .set({
        lastCommandAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

    console.log("🕒 Throttle meta updated");

  } catch (err) {
    console.warn("⚠ Meta update failed (non-fatal):", err);
    // We do NOT fail the command if this fails
  }

  // ===============================
  // 3️⃣ WRITE HISTORY (SENT)
  // ===============================
  try {
  await historyRef.add({
    type,
    status: "SENT",
    issuedBy: auth.currentUser.uid,
    createdAt,
    expiresAt: firebase.firestore.Timestamp.fromMillis(
      Date.now() + HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
    )
  });
} catch (err) {
    console.warn("⚠ History write failed:", err);
  }

  toast(`✅ ${type.toUpperCase()} sent`, "success");
  // Start 5 second cooldown
  commandCooldowns.set(pcId, true);
  renderDashboard(); // force UI refresh

  setTimeout(() => {
    commandCooldowns.delete(pcId);
    renderDashboard();
  }, 5000);

  setTimeout(() => pendingCommands.delete(key), 5000);
}
// =====================================================
// VIEW HISTORY MODAL
// =====================================================
async function viewHistory(pcId) {
  console.log("viewHistory() called for", pcId);

  try {
    const historyRef = companyPcsRef()
      .doc(pcId)
      .collection("history")
      .orderBy("createdAt", "desc")
      .limit(50);

    const snap = await historyRef.get();
    console.log("history snapshot size:", snap.size);

    if (snap.empty) {
      showAuditModal(`
        <div style="text-align:center;font-size:13px;color:#777;">
          No history records for this PC
        </div>
      `);
      return;
    }

    let html = `<div style="max-height:360px;overflow:auto;font-size:12px;">`;

    snap.forEach(doc => {
      const h = doc.data();
      const ts = h.createdAt?.toMillis?.();
      const time = ts ? new Date(ts).toLocaleString() : "unknown time";

     const color =
      h.status === "SENT"   ? "#2e7d32" :
      h.status === "FAILED" ? "#c62828" :
      "#555";

      html += `
        <div style="
          padding:8px 10px;
          border-bottom:1px solid rgba(0,0,0,0.06);
          display:flex;
          justify-content:space-between;
          align-items:center;
        ">
          <div>
            <div style="font-weight:600;">${h.type.toUpperCase()}</div>
            <div style="font-size:11px;color:#777;">${time}</div>
          </div>
          <div style="font-weight:700;font-size:11px;color:${color};">
            ${h.status}
          </div>
        </div>
      `;
    });

    html += `</div>`;
    showAuditModal(html, "history");

  } catch (err) {
    console.error("History load failed:", err);

    showAuditModal(`
    <div style="text-align:center;font-size:13px;color:#777;">
      No history records for this PC
    </div>
  `, "history");
  }
}

let modalMode = null; // "audit" | "history" | null
let auditModalOpen = false;

function showAuditModal(html, mode) {
  const modal = document.getElementById("audit-modal");
  const content = document.getElementById("audit-content");
  const title = document.getElementById("modal-title");

  modalMode = mode;

  title.textContent =
    mode === "audit"
      ? "🛡 Local Audit Verification"
      : "📜 Command History";

  content.innerHTML = html;

  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("show");
  });

  trapFocus(modal);
}

function closeAuditModal() {
  const modal = document.getElementById("audit-modal");

  modal.classList.remove("show");

  setTimeout(() => {
    modal.hidden = true;
    modalMode = null;
    auditModalOpen = false; // 👈 ADD THIS
  }, 180);

    if (modal._trapHandler) {
    modal.removeEventListener("keydown", modal._trapHandler);
    modal._trapHandler = null;
  }
}

function openAuditViewer(pcId) {
  if (modalMode === "audit") return;

  const pc = window._pcs?.find(p => p.id === pcId);
  if (!pc || !pc.audit) {
    toast("⚠ No audit data available", "error");
    return;
  }

  auditModalOpen = true;

  const ageSec = Math.floor(
    (Date.now() - pc.audit.lastEventAt * 1000) / 1000
  );

  const verification = auditVerificationCache.get(pcId);

  let verificationHtml = "";

  if (verification?.valid) {
    verificationHtml = `
      <div style="
        padding:6px 10px;
        border-radius:6px;
        background:#e8f5e9;
        color:#2e7d32;
        font-weight:700;
        margin-bottom:10px;
      ">
        ✔ Cryptographic chain verified
      </div>
    `;
  } else {
    verificationHtml = `
      <div style="
        padding:6px 10px;
        border-radius:6px;
        background:#ffebee;
        color:#c62828;
        font-weight:700;
        margin-bottom:10px;
      ">
        ⚠ Integrity failure: ${verification?.reason || "Unknown"}
      </div>
    `;
  }

  showAuditModal(`
    ${verificationHtml}

    <div style="margin-bottom:8px;">
      <b>PC:</b> ${pcId}
    </div>

    <div style="margin-bottom:6px;">
      <b>Events recorded:</b> ${pc.audit.events}
    </div>

    <div style="margin-bottom:10px;">
      <b>Last activity:</b> ${ageSec}s ago
    </div>

    <div style="
      font-size:12px;
      color:#555;
      border-top:1px solid #eee;
      text-align:center;
      padding-top:10px;
    ">
      This audit record was generated locally by the PC agent.
      The admin UI verifies its cryptographic integrity.
    </div>
  `, "audit");
}

function trapFocus(modal) {
  const focusable = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function handleTab(e) {
    if (e.key !== "Tab") return;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  modal._trapHandler = handleTab; // 👈 STORE REF
  modal.addEventListener("keydown", handleTab);
  first.focus();
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && modalMode !== null) {
    closeAuditModal();
  }
});

function isTamperDetected(pc) {
  const result = auditVerificationCache.get(pc.id);

  // No verification yet
  if (!result) return false;

  // Cryptographic failure
  if (!result.valid) return true;

  // Time-based freeze detection
  if (!pc.audit) return true;

  const now = Date.now();
  const auditAge = now - pc.audit.lastEventAt * 1000;

  if (auditAge > 10 * 60 * 1000) return true;

  if (pc.agentAliveAt && auditAge > 60 * 1000) return true;

  return false;
}
let activeConfirmToast = null;

function confirmToastInline(message, {
  confirmText = "Confirm",
  tone = "warn", // "warn" | "danger"
  onConfirm
}) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  // Ensure only one confirm toast exists
  if (activeConfirmToast) activeConfirmToast.remove();

  const el = document.createElement("div");
  el.className = `toast confirm-inline ${tone}`;
  el.style.opacity = "1";

  el.innerHTML = `
  <span style="font-size:14px;font-weight:600;">
    ${message}
  </span>

  <div>
    <button class="ghost-btn">Cancel</button>
    <button class="action-btn">${confirmText}</button>
  </div>
`;

  const [cancelBtn, confirmBtn] = el.querySelectorAll("button");

  const close = () => {
    el.remove();
    activeConfirmToast = null;
    document.removeEventListener("keydown", esc);
  };

  cancelBtn.onclick = close;
  confirmBtn.onclick = () => {
    close();
    onConfirm();
  };

  function esc(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", esc);

  container.appendChild(el);
  activeConfirmToast = el;
}
function renderDashboard() {
  if (!window._pcs) return;

  pcsDiv.innerHTML = "";
  renderSummary(window._pcs);

  window._pcs
    .filter(matchesSearch)
    .sort((a, b) => {
      const severity = { OFFLINE: 0, STALE: 1, ONLINE: 2 };
      return severity[getPcHealth(a).status] - severity[getPcHealth(b).status];
    })
    .forEach(pc => renderPc(pc));
}
async function cleanupExpiredSmart() {
  const now = firebase.firestore.Timestamp.now();
  const nowMillis = Date.now();

  let totalDeleted = 0;

  // =========================
  // 1️⃣ CLEAN HISTORY
  // =========================
  const expiredHistory = await db.collectionGroup("history")
    .where("expiresAt", "<", now)
    .limit(101)
    .get();

  if (!expiredHistory.empty) {
    const batch = db.batch();
    expiredHistory.docs.slice(0, 100).forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    totalDeleted += expiredHistory.size;
  }

  // =========================
  // 2️⃣ CLEAN OLD SESSIONS
  // =========================
  const sessionSnap = await db.collectionGroup("sessions")
    .limit(200)
    .get();

  const sessionBatch = db.batch();
  let sessionDeleted = 0;

  sessionSnap.forEach(doc => {
    const data = doc.data();

    if (!data.session_active && data.startedAtLocal) {
      const ageDays =
        (nowMillis - data.startedAtLocal.toMillis()) / (1000 * 60 * 60 * 24);

      if (ageDays > SESSION_RETENTION_DAYS) {
        sessionBatch.delete(doc.ref);
        sessionDeleted++;
      }
    }
  });

  if (sessionDeleted > 0) {
    await sessionBatch.commit();
    totalDeleted += sessionDeleted;
  }

  // =========================
  // 3️⃣ SMART TOAST LOGIC
  // =========================
  if (totalDeleted > 0 && totalDeleted <= 20) {
    toast(`🧹 Cleaned ${totalDeleted} expired records`, "info");
  }

  if (totalDeleted > 20) {
    toast(`⚠ Large cleanup: ${totalDeleted} records removed`, "warn", 4000);
  }

  console.log(`Smart cleanup removed ${totalDeleted} docs`);
}
async function verifyAuditChain(auditLines) {
  if (!auditLines || auditLines.length === 0) {
    return { valid: true, reason: "No audit data" };
  }

  let previousHash = "GENESIS";
  let expectedSeq = null;

  for (let i = 0; i < auditLines.length; i++) {
    let entry = JSON.parse(auditLines[i]);

    // 1️⃣ Sequence continuity check
    if (expectedSeq === null) {
      expectedSeq = entry.seq;
    } else {
      if (entry.seq !== expectedSeq + 1) {
        return {
          valid: false,
          reason: `Sequence break at seq ${entry.seq}`
        };
      }
    }
    expectedSeq = entry.seq;

    // 2️⃣ prevHash check
    if (i > 0 && entry.prevHash !== previousHash) {
      return {
        valid: false,
        reason: `prevHash mismatch at seq ${entry.seq}`
      };
    }

    // 3️⃣ Recompute hash
    let clone = { ...entry };
    delete clone.hash;

    function canonicalize(obj) {
      if (Array.isArray(obj)) {
        return obj.map(canonicalize);
      }

      if (obj && typeof obj === "object") {
        return Object.keys(obj)
          .sort()
          .reduce((acc, key) => {
            acc[key] = canonicalize(obj[key]);
            return acc;
          }, {});
      }

      return obj;
    }

    let canonical = canonicalize(clone);
    let raw = JSON.stringify(canonical);
    let encoder = new TextEncoder();
    let data = encoder.encode(raw);
    let digest = await crypto.subtle.digest("SHA-256", data);

    let computedHash = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (computedHash !== entry.hash) {
      return {
        valid: false,
        reason: `Hash mismatch at seq ${entry.seq}`
      };
    }

    previousHash = entry.hash;
  }

  return { valid: true };
}
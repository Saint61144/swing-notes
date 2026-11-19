const byId = (id) => document.getElementById(id);
const description = byId("description");
const controls = byId("controls");
const buttons = [...controls.querySelectorAll("[data-mode]")];
const account = byId("account");
const nameInput = byId("my-name");
const progressArea = byId("progress-area");
const progress = byId("progress");
const stop = byId("stop");
const partial = byId("partial");
const feedback = byId("feedback");
let tab;
let pollTimer;
let pending = false;

function report(text = "") {
  feedback.textContent = text;
  feedback.hidden = !text;
}

function render(state) {
  if (!state) throw new Error("Swing Notes lost its connection to the Discord tab.");
  if (!state.channel) {
    description.textContent = "Open a one-to-one DM on Discord web.";
    controls.hidden = true;
    progressArea.hidden = true;
    return;
  }

  description.textContent = state.title ? `${state.title} · Dated text file` : "Save dated text from the open conversation.";
  controls.hidden = false;
  if (!nameInput.value && !account.open && state.selfName) nameInput.placeholder = state.selfName;
  const running = ["latest", "scanning", "waiting", "saving"].includes(state.phase);
  const partialReady = state.phase === "partial";
  for (const button of buttons) button.disabled = running || pending;
  nameInput.disabled = running;
  stop.hidden = !running || state.phase === "saving";
  partial.hidden = !partialReady;

  progressArea.hidden = state.phase === "idle";
  byId("stage").textContent = ({
    latest: "Finding newest messages",
    scanning: "Reading older messages",
    waiting: "Waiting for Discord",
    saving: "Preparing download",
    done: "Download started",
    partial: "Scan ended early",
    empty: "No messages to download",
    error: "Couldn’t start"
  })[state.phase] ?? "";
  byId("count").textContent = state.count ? `${state.count.toLocaleString()} found` : "";
  byId("note").textContent = state.note
    || (running ? "Keep this Discord tab open. You can reopen this popup to check progress." : "");
  if (running) progress.removeAttribute("value");
  else progress.value = state.phase === "done" || state.phase === "empty" ? 100 : 0;
  progress.hidden = partialReady || state.phase === "error";
}

function send(command, options) {
  return chrome.tabs.sendMessage(tab.id, { swingNotes: command, ...options });
}

async function refresh() {
  try {
    render(await send("status"));
    pollTimer = setTimeout(refresh, 335);
  } catch {
    controls.hidden = true;
    progressArea.hidden = true;
    description.textContent = "Reopen Swing Notes on the Discord DM to reconnect.";
  }
}

function run(command, options) {
  if (pending) return;
  pending = true;
  report();
  send(command, options).then((state) => {
    pending = false;
    if (state?.needsName) {
      account.open = true;
      nameInput.focus();
      report("Enter your display name so Swing Notes can tell the two sides apart.");
    }
    render(state);
  }).catch(() => {
    pending = false;
    report("Discord changed tabs or reloaded. Open the DM and try again.");
  });
}

for (const button of buttons) {
  button.addEventListener("click", () => run("start", { mode: button.dataset.mode, name: nameInput.value.trim() }));
}
stop.addEventListener("click", () => run("stop"));
partial.addEventListener("click", () => run("partial"));

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(?:@me|%40me)\/\d+\/?(?:[?#].*)?$/i.test(tab.url ?? "")) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture.js"] });
  await refresh();
}

init().catch(() => {
  description.textContent = "Open the DM in Discord web and try clicking Swing Notes again.";
});
window.addEventListener("pagehide", () => clearTimeout(pollTimer));

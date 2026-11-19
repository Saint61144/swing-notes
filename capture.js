(() => {
  if (globalThis.swingNotesListening) return;
  globalThis.swingNotesListening = true;

  const listSelector = '[data-list-id="chat-messages"]';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const running = new Set(["latest", "scanning", "waiting", "saving"]);
  const historyTimeout = 90_000;
  const recheckDelays = [900, 2_000, 4_500, 9_000, 18_000, 28_000];
  const channelId = () => location.pathname.match(/^\/channels\/(?:@me|%40me)\/(\d{16,22})\/?$/i)?.[1] ?? "";
  const normalize = (name) => name.normalize("NFKC").trim().toLowerCase();
  let session;

  function avatarId(node) {
    const candidates = node?.querySelectorAll('img[src*="/avatars/"], image[href*="/avatars/"]') ?? [];
    for (const avatar of candidates) {
      const url = avatar.getAttribute("src") || avatar.getAttribute("href");
      const id = url.match(/\/avatars\/(\d{16,22})\//)?.[1];
      if (id) return id;
    }
    return "";
  }

  function ownAccount() {
    const panel = document.querySelector('section[aria-label="User area"], section[class*="panels"], [class*="panels_"]');
    const profile = panel?.querySelector('[class*="avatarWrapper"]');
    const nameTag = panel?.querySelector('[class*="nameTag"]') ?? profile;
    const labels = [...(nameTag?.querySelectorAll('[class*="title_"], [class*="displayName"]') ?? [])];
    const names = labels.map((label) => label.textContent.trim()).filter(Boolean);
    return { id: avatarId(profile), names };
  }

  function conversation(id) {
    const link = document.querySelector(`a[href="/channels/@me/${id}"]`);
    return link?.querySelector('[class*="name_"]')?.textContent.trim().slice(0, 80) ?? "";
  }

  function findList() {
    return [...document.querySelectorAll(listSelector)].find((list) => list.getClientRects().length);
  }

  function scrollerFor(list) {
    for (let node = list.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }

  function messageScroller(list, previous) {
    const current = list && scrollerFor(list);
    if (current) return current;
    if (previous?.isConnected && previous.clientHeight) return previous;
    const candidates = document.querySelectorAll('[class*="messagesWrapper"] [class*="scroller"]');
    return [...candidates].find((node) =>
      node.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY));
  }

  function getMessageId(row, channel) {
    const parts = row.id.match(/^chat-messages-(?:(\d{16,22})-)?(\d{16,22})$/);
    return parts && (!parts[1] || parts[1] === channel) ? parts[2] : "";
  }

  function isOlder(id, reference) {
    return id && (!reference || id.length < reference.length
      || (id.length === reference.length && id < reference));
  }

  function scrollStep(scroller) {
    return Math.max(18, Math.min(440, scroller.clientHeight * 0.72));
  }

  function messagesInView(rows, scroller) {
    const viewport = scroller.getBoundingClientRect();
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      if (bounds.height > 0 && bounds.top < viewport.bottom && bounds.bottom > viewport.top) return true;
    }
    return false;
  }

  function contentText(element) {
    let out = "";
    const newline = () => { if (out && !out.endsWith("\n")) out += "\n"; };

    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "IMG") {
        out += node.getAttribute("alt") ?? "";
        return;
      }
      if (node.matches('[aria-hidden="true"], [class*="screenReaderOnly"], [class^="edited_"], [class*=" edited_"]')) return;
      if (node.tagName === "BR") {
        out += "\n";
        return;
      }
      const block = /^(DIV|P|UL|OL|LI|PRE|BLOCKQUOTE|H[1-6])$/.test(node.tagName);
      if (block) newline();
      for (const child of node.childNodes) visit(child);
      if (block) newline();
    }

    for (const child of element.childNodes) visit(child);
    return out.replace(/^\n+|\n+$/g, "");
  }

  function messageTime(row, id) {
    const time = row.querySelector(`time#message-timestamp-${id}[datetime], #message-timestamp-${id} time[datetime]`);
    const parsed = Date.parse(time?.getAttribute("datetime") ?? "");
    // Discord's message IDs also encode creation time, including for grouped messages.
    return Number.isFinite(parsed) ? parsed : Number(BigInt(id) >> 22n) + 1420070400000;
  }

  function capture(list, scan) {
    const rows = list.querySelectorAll('li[id^="chat-messages-"]');
    for (const row of rows) {
      const id = getMessageId(row, scan.channel);
      if (!id) continue;
      const article = row.querySelector('[role="article"]') ?? row;
      const referenced = article.getAttribute("aria-labelledby")?.match(/\bmessage-username-(\d+)\b/)?.[1];
      const headingId = referenced ?? id;
      const heading = row.querySelector(`#message-username-${id}`);
      if (heading && !scan.authors.has(id)) {
        const name = (heading.querySelector('[class^="username"], [role="button"]') ?? heading).textContent.trim();
        if (name) scan.authors.set(id, { name, id: avatarId(heading.closest("h3, h2")?.parentElement ?? article) });
      }
      const current = scan.rows.get(id);
      if (current) {
        if (heading || referenced) current.heading = headingId;
        continue;
      }

      const element = row.querySelector(`#message-content-${id}`);
      if (!element) continue;
      const text = contentText(element);
      if (!text.trim()) continue;
      const time = messageTime(row, id);
      scan.rows.set(id, { id, time, text, heading: headingId });
      scan.count++;
    }
    return rows;
  }

  function jumpButton(scroller) {
    const button = scroller.parentElement?.querySelector(
      '[class*="jumpToPresentBar"] button, [class*="jumpToPresentBar"] [role="button"]'
    );
    return button?.getClientRects().length ? button : null;
  }

  function atBeginning(list, scroller, first) {
    const start = scroller.querySelector(
      '[class*="chatWelcome"], [class*="channelStart"], [class*="channelIntro"], [class^="emptyChannelIcon"]'
    );
    if (start && (!first || start.getBoundingClientRect().bottom <= first.getBoundingClientRect().bottom)) return true;
    // The English welcome text is useful when Discord changes its generated class names.
    const welcomeText = /beginning of your direct message history|beginning of this conversation/i;
    for (const child of list.children) {
      if (first && (child === first || child.contains(first))) break;
      if (welcomeText.test(child.textContent)) return true;
    }
    return [...scroller.querySelectorAll('p, [class*="description"], [class*="subtitle"]')].some((element) =>
      !element.closest('li[id^="chat-messages-"]')
      && (!first || (element.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING))
      && welcomeText.test(element.textContent));
  }

  function loading(scroller) {
    if (scroller.getAttribute("aria-busy") === "true") return true;
    const viewport = scroller.getBoundingClientRect();
    const indicators = scroller.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], [class*="loadingMore"], [class*="loadingMessages"], [class*="placeholderMessage"], [class*="messagePlaceholder"]'
    );
    return [...indicators].some((element) => {
      if (element.closest('li[id^="chat-messages-"]')) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
  }

  function discordAsksToWait() {
    return [...document.querySelectorAll('[role="alert"], [class^="toast_"]')].some((element) =>
      element.getClientRects().length && !element.closest(listSelector)
      && /too many requests|rate.limit|try again later/i.test(element.textContent));
  }

  function stillRunning(scan) {
    return session === scan && running.has(scan.phase) && channelId() === scan.channel;
  }

  async function seekLatest(scan) {
    const deadline = performance.now() + 30000;
    let stableSince = 0;
    let lastEnd;
    let clicked;
    while (stillRunning(scan) && performance.now() < deadline) {
      const list = findList();
      const scroller = list && scrollerFor(list);
      if (scroller && !discordAsksToWait()) {
        const jump = jumpButton(scroller);
        if (jump && jump !== clicked) {
          clicked = jump;
          jump.click();
          stableSince = 0;
        }
        if (!loading(scroller) && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 2) {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
        }
        const end = list.lastElementChild;
        if (jump || loading(scroller) || end !== lastEnd) {
          stableSince = 0;
          lastEnd = end;
        } else {
          if (!stableSince) stableSince = performance.now();
          if (performance.now() - stableSince >= 500) return true;
        }
      }
      await wait(240);
    }
    return false;
  }

  function finishEarly(scan, note) {
    scan.phase = scan.rows.size ? "partial" : "error";
    scan.note = note;
  }

  async function backtrackToMessages(scan, scroller, oldest, attempt) {
    scan.note = "Scrolling farther down to reload the chat.";
    const height = scroller.clientHeight;
    const start = scroller.scrollTop;
    const stride = Math.max(72, Math.min(500, height * 0.72));
    const limit = Math.min(12 + attempt * 2, 20) * height;
    const maxSteps = Math.ceil(limit / stride);
    let loadedAt = null;
    for (let step = 0; step <= maxSteps; step++) {
      if (!stillRunning(scan) || !scroller?.isConnected || discordAsksToWait()) return false;
      const top = scroller.scrollTop;
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const target = Math.min(bottom, start + limit, top + stride);
      if (step < maxSteps && target - top >= 3) {
        scroller.scrollTo({ top: target, behavior: "instant" });
        await wait(step % 4 === 3 ? 270 : 145);
      }

      if (!stillRunning(scan) || discordAsksToWait()) return false;
      const list = findList();
      scroller = messageScroller(list, scroller);
      if (!scroller) return false;
      const rows = list ? capture(list, scan) : [];
      const first = rows[0];
      if (first && isOlder(getMessageId(first, scan.channel), oldest)) return false;
      const visible = messagesInView(rows, scroller);
      const position = scroller.scrollTop;
      const reachedEdge = step === maxSteps || target - top < 3
        || position >= scroller.scrollHeight - scroller.clientHeight - 3 || position >= start + limit - 3;
      if (!visible) loadedAt = null;
      else if (loadedAt === null) loadedAt = position;

      // Pass the edge of the placeholder region before giving Discord time to settle.
      if (visible && (reachedEdge || (position - loadedAt >= height * 1.5 && position - start >= height * 2.4))) {
        scan.note = "Loaded messages are visible. Waiting before scrolling back up.";
        await wait(1450);
        return true;
      }
      if (reachedEdge) return false;
    }
    return false;
  }

  async function readHistory(scan) {
    if (!await seekLatest(scan)) {
      if (stillRunning(scan)) finishEarly(scan, "Discord didn’t show the newest messages. Let the DM load and try again.");
      return;
    }

    let oldest = "";
    let waitingSince = 0;
    let nextRecheck = Infinity;
    let rechecks = 0;
    let lastMovement = performance.now();
    let previousTop;
    let scroller;
    let reapproaching = false;
    while (stillRunning(scan)) {
      const list = findList();
      scroller = messageScroller(list, scroller);
      const now = performance.now();
      const rows = list ? capture(list, scan) : [];
      const first = rows[0];
      const firstId = first ? getMessageId(first, scan.channel) : "";
      if (isOlder(firstId, oldest)) {
        oldest = firstId;
        waitingSince = 0;
        rechecks = 0;
        nextRecheck = Infinity;
        reapproaching = false;
      }
      const top = scroller?.scrollTop;
      if (top !== previousTop) {
        lastMovement = now;
        previousTop = top;
      }
      const fetching = scroller && loading(scroller);
      const coolingDown = discordAsksToWait();

      if (list && scroller && top <= 2 && !fetching && !coolingDown && atBeginning(list, scroller, first)) {
        save(scan);
        return;
      }

      const visible = scroller && messagesInView(rows, scroller);
      if (!visible || top <= 2) reapproaching = false;
      const stalled = now - lastMovement > 1800;
      if (scroller && visible && top > 2 && !coolingDown && !stalled && (!fetching || reapproaching)) {
        scan.phase = "scanning";
        scan.note = "";
        const step = reapproaching ? Math.max(18, scroller.clientHeight * 0.23) : scrollStep(scroller);
        scroller.scrollTo({ top: Math.max(0, top - step), behavior: "instant" });
        await wait(reapproaching ? 380 : 300);
        continue;
      }

      if (!waitingSince) {
        waitingSince = now;
        if (!rechecks) nextRecheck = now + recheckDelays[0];
      }
      if (now - waitingSince >= historyTimeout) break;
      scan.phase = "waiting";
      scan.note = coolingDown
        ? "Discord asked you to wait. Scrolling is paused."
        : "Waiting for older messages. Keep this Discord tab open.";
      if (coolingDown) nextRecheck = Math.max(nextRecheck, now + 1200);
      if (scroller && !coolingDown && now >= nextRecheck) {
        reapproaching = await backtrackToMessages(scan, scroller, oldest, rechecks);
        if (reapproaching) lastMovement = performance.now();
        rechecks++;
        nextRecheck = performance.now() + (recheckDelays[rechecks] ?? Infinity);
      }
      await wait(250);
    }
    if (stillRunning(scan)) {
      finishEarly(scan, "Discord didn’t load more history within 90 seconds. You can save the messages already found.");
    }
  }

  function side(author, self) {
    if (!author) return "";
    if (self.id && author.id) return self.id === author.id ? "mine" : "theirs";
    if (self.names.length) return self.names.includes(normalize(author.name)) ? "mine" : "theirs";
    return "";
  }

  function save(scan, note = "", partial = false) {
    scan.phase = "saving";
    const rows = [...scan.rows.values()];
    const ids = new Set([...scan.authors.values()].map((author) => author.id).filter(Boolean));
    if (ids.size > 2) {
      scan.phase = "error";
      scan.note = "This conversation has more than two participants. Open a one-to-one DM.";
      scan.rows.clear();
      scan.authors.clear();
      return;
    }
    rows.sort((a, b) => a.time - b.time || a.id.length - b.id.length || a.id.localeCompare(b.id));
    const chunks = [];
    let batch = [];
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const author = scan.authors.get(row.heading);
      const authorSide = side(author, scan.self);
      if (scan.mode !== "both" && authorSide !== scan.mode) {
        if (!authorSide) skipped++;
        continue;
      }
      const speaker = scan.mode === "both" ? `${author?.name || "Unknown speaker"}: ` : "";
      batch.push(`[${new Date(row.time).toISOString()}] ${speaker}${row.text}\n\n`);
      count++;
      if (batch.length === 512) {
        chunks.push(batch.join(""));
        batch = [];
      }
    }
    if (batch.length) chunks.push(batch.join(""));
    if (skipped) note += `${note ? " " : ""}${skipped.toLocaleString()} messages had no identifiable sender.`;

    if (count) {
      const blob = new Blob(chunks, { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `swing-notes-${scan.mode}${partial ? "-partial" : ""}.txt`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    scan.phase = count ? "done" : "empty";
    scan.count = count;
    scan.note = note || (count ? "Saved as dated text, oldest first." : "No text matched this selection.");
    scan.rows.clear();
    scan.authors.clear();
  }

  function state(extra = {}) {
    const channel = channelId();
    if (session && session.channel !== channel) session = undefined;
    return {
      channel,
      title: channel ? conversation(channel) : "",
      selfName: channel ? ownAccount().names[0] ?? "" : "",
      phase: session?.phase ?? "idle",
      count: session?.count ?? 0,
      note: session?.note ?? "",
      ...extra
    };
  }

  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !request?.swingNotes) return;
    const current = state();
    if (!current.channel) {
      reply(current);
      return;
    }

    if (request.swingNotes === "start" && !running.has(current.phase)
      && ["mine", "theirs", "both"].includes(request.mode)) {
      const account = ownAccount();
      const override = typeof request.name === "string" ? request.name.trim().slice(0, 80) : "";
      const self = { id: account.id, names: (override ? [override] : account.names).map(normalize) };
      if (request.mode !== "both" && !self.id && !self.names.length) {
        reply(state({ needsName: true }));
        return;
      }
      const scan = {
        channel: current.channel, mode: request.mode, self, rows: new Map(), authors: new Map(),
        count: 0, note: "", phase: "latest"
      };
      session = scan;
      readHistory(scan).catch(() => {
        if (stillRunning(scan)) finishEarly(scan, "Discord’s message list changed during the scan. Try reopening the DM.");
      });
    } else if (request.swingNotes === "stop" && running.has(current.phase)) {
      finishEarly(session, "You stopped the scan.");
    } else if (request.swingNotes === "partial" && current.phase === "partial") {
      save(session, "This file contains the messages collected before the scan stopped.", true);
    }
    reply(state());
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  const exportBtn = document.getElementById('exportBtn');
  const statusText = document.getElementById('statusText');
  const convCount = document.getElementById('convCount');
  const attachCount = document.getElementById('attachCount');
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const warningBox = document.getElementById('warningBox');
  const logArea = document.getElementById('logArea');
  const includeAttachments = document.getElementById('includeAttachments');
  const includeArchived = document.getElementById('includeArchived');
  const fromInput = document.getElementById('fromIndex');
  const toInput = document.getElementById('toIndex');
  const historyBanner = document.getElementById('historyBanner');
  const historyCount = document.getElementById('historyCount');
  const historyDate = document.getElementById('historyDate');
  const continueBtn = document.getElementById('continueBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const nextBatch = document.getElementById('nextBatch');

  const STORAGE_KEY = 'chatgptExportHistory';
  const BATCH_SIZE = 100;

  // ── History helpers ───────────────────────────────────────

  function loadHistory(callback) {
    chrome.storage.local.get([STORAGE_KEY], result => {
      callback(result[STORAGE_KEY] || { ids: [], lastExport: null, lastTotal: null });
    });
  }

  function saveHistory(newIds, total, callback) {
    loadHistory(existing => {
      const merged = new Set(existing.ids);
      newIds.forEach(id => merged.add(id));
      const updated = {
        ids: [...merged],
        lastExport: new Date().toISOString(),
        lastTotal: total || existing.lastTotal,
      };
      chrome.storage.local.set({ [STORAGE_KEY]: updated }, callback);
      // Update banner without reload
      showHistoryBanner(updated);
    });
  }

  function clearHistory(callback) {
    chrome.storage.local.remove(STORAGE_KEY, () => {
      historyBanner.style.display = 'none';
      if (callback) callback();
    });
  }

  // ── History banner ────────────────────────────────────────

  function showHistoryBanner(history) {
    if (!history || history.ids.length === 0) {
      historyBanner.style.display = 'none';
      return;
    }
    historyBanner.style.display = 'block';
    historyCount.textContent = history.ids.length;
    if (history.lastExport) {
      const d = new Date(history.lastExport);
      historyDate.textContent = 'Last export: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (history.lastTotal) {
      historyDate.textContent += ' · ' + history.ids.length + '/' + history.lastTotal + ' total';
    }
  }

  // ── Initialise ────────────────────────────────────────────

  loadHistory(history => {
    showHistoryBanner(history);
  });

  // Check if we're on chatgpt.com
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('https://chatgpt.com')) {
      warningBox.style.display = 'block';
      exportBtn.disabled = true;
      setStatus('Wrong page', 'error');
    }
  });

  // ── Range controls ────────────────────────────────────────

  // "Continue from next batch" — pre-fills from/to based on history
  continueBtn.addEventListener('click', () => {
    loadHistory(history => {
      const nextFrom = history.ids.length + 1;
      fromInput.value = nextFrom;
      toInput.value = nextFrom + BATCH_SIZE - 1;
      historyBanner.style.display = 'none';
    });
  });

  clearHistoryBtn.addEventListener('click', () => {
    clearHistory(() => {
      fromInput.value = 1;
      toInput.value = BATCH_SIZE;
    });
  });

  // ── Logging helpers ───────────────────────────────────────

  function addLog(msg) {
    logArea.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = msg;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }

  function setStatus(text, type) {
    statusText.textContent = text;
    statusText.className = 'status-value' + (type ? ' ' + type : '');
  }

  function updateProgress(current, total) {
    progressContainer.style.display = 'block';
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent = current + ' / ' + total;
  }

  // ── Export ────────────────────────────────────────────────

  exportBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    nextBatch.style.display = 'none';
    setStatus('Exporting...', '');
    addLog('Starting export...');

    const fromIndex = parseInt(fromInput.value) || 1;
    const toIndex = parseInt(toInput.value) || 0;

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      chrome.tabs.sendMessage(
        tab.id,
        {
          action: 'startExport',
          options: {
            includeAttachments: includeAttachments.checked,
            includeArchived: includeArchived.checked,
            fromIndex: fromIndex,
            toIndex: toIndex > 0 ? toIndex : 0,
          },
        },
        () => {
          if (chrome.runtime.lastError) {
            setStatus('Error', 'error');
            addLog('Cannot connect to the page. Please reload the chatgpt.com tab and try again.');
            exportBtn.disabled = false;
          }
        }
      );
    });
  });

  // ── Messages from content script ─────────────────────────

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'export-log') {
      addLog(msg.text);
    }
    if (msg.type === 'export-status') {
      setStatus(msg.text, msg.statusType || '');
    }
    if (msg.type === 'export-progress') {
      updateProgress(msg.current, msg.total);
    }
    if (msg.type === 'export-stats') {
      if (msg.conversations !== undefined) convCount.textContent = msg.conversations;
      if (msg.attachments !== undefined) attachCount.textContent = msg.attachments;
    }
    if (msg.type === 'export-ids') {
      // Persist successfully exported IDs
      saveHistory(msg.ids || [], msg.total || null, null);
    }
    if (msg.type === 'export-done') {
      setStatus('Done!', '');
      convCount.textContent = msg.conversations || '-';
      attachCount.textContent = msg.attachments || '-';
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export Again';
      addLog('Export complete! File downloaded.');

      // Suggest next batch
      if (msg.nextFrom) {
        const nextTo = msg.nextFrom + BATCH_SIZE - 1;
        nextBatch.style.display = 'block';
        nextBatch.innerHTML =
          'Next batch: <strong>' + msg.nextFrom + '–' + nextTo + '</strong> of ' + (msg.total || '?') +
          ' &nbsp;<button id="loadNextBtn" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:12px;text-decoration:underline;">Load range</button>';
        document.getElementById('loadNextBtn').addEventListener('click', () => {
          fromInput.value = msg.nextFrom;
          toInput.value = nextTo;
          nextBatch.style.display = 'none';
        });
      } else if (msg.total) {
        nextBatch.style.display = 'block';
        nextBatch.textContent = 'All ' + msg.total + ' conversations exported!';
        nextBatch.style.color = '#10b981';
      }
    }
    if (msg.type === 'export-error') {
      setStatus('Error', 'error');
      addLog('ERROR: ' + msg.text);
      exportBtn.disabled = false;
    }
  });
});

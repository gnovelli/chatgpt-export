/**
 * ChatGPT Workspace Exporter
 *
 * Bulk exports all conversations from ChatGPT, including Team/Business workspaces
 * where OpenAI doesn't provide a native export option.
 *
 * Usage: Run in the browser console while logged into chatgpt.com
 *
 * ── Partial export ───────────────────────────────────────────────────────────
 * Conversations are sorted oldest-first (position 1 = oldest).
 * Set EXPORT_FROM / EXPORT_TO to export a slice, e.g. 1–100, then 101–200.
 * Set EXPORT_TO to 0 to export all from EXPORT_FROM to the end.
 *
 * Progress is saved in localStorage so you can see what you have already
 * exported and pick up where you left off.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MIT License - https://github.com/hoya98/chatgpt-export
 */

(async function ChatGPTExport() {
  'use strict';

  const CONFIG = {
    BASE_URL: 'https://chatgpt.com/backend-api',
    SESSION_URL: 'https://chatgpt.com/api/auth/session',
    PAGE_SIZE: 100,
    DELAY_BETWEEN_FETCHES: 800,
    DELAY_BETWEEN_PAGES: 300,
    DELAY_BETWEEN_ATTACHMENTS: 500,
    MAX_RETRIES: 5,
    INITIAL_BACKOFF: 500,
    MAX_BACKOFF: 10000,

    // ── Range (1-based, oldest-first) ─────────────────────────────────────────
    // Change these to export a specific slice of your conversations.
    // EXPORT_TO: 0 means "export everything from EXPORT_FROM to the end".
    EXPORT_FROM: 1,
    EXPORT_TO: 0,
  };

  const HISTORY_KEY = 'chatgpt-export-history';

  // ── Helpers ──────────────────────────────────────────────

  function log(msg) {
    console.log(`[ChatGPT Export] ${msg}`);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── History (localStorage) ───────────────────────────────

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveHistory(newIds) {
    const existing = new Set(loadHistory());
    newIds.forEach(id => existing.add(id));
    localStorage.setItem(HISTORY_KEY, JSON.stringify([...existing]));
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }

  // ── Auth ─────────────────────────────────────────────────

  async function getAccessToken() {
    const resp = await fetch(CONFIG.SESSION_URL, { credentials: 'include' });
    if (!resp.ok) throw new Error('Failed to get session. Are you logged in?');
    const data = await resp.json();
    if (!data.accessToken) throw new Error('No access token in session response.');
    return data.accessToken;
  }

  function getWorkspaceAccountId() {
    const cookie = document.cookie
      .split(';')
      .find(c => c.trim().startsWith('_account='));
    return cookie ? cookie.split('=')[1].trim() : null;
  }

  function buildHeaders(token, accountId) {
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    };
    if (accountId) {
      headers['Chatgpt-Account-Id'] = accountId;
    }
    return headers;
  }

  async function fetchWithRetry(url, headers, retries) {
    retries = retries || CONFIG.MAX_RETRIES;
    let delay = CONFIG.INITIAL_BACKOFF;
    for (let i = 0; i < retries; i++) {
      const resp = await fetch(url, { headers: headers, credentials: 'include' });
      if (resp.ok) return resp;
      if (resp.status === 429) {
        const retryAfter = resp.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        log('Rate limited. Waiting ' + waitMs + 'ms (retry ' + (i + 1) + '/' + retries + ')');
        await sleep(waitMs);
        delay = Math.min(delay * 2, CONFIG.MAX_BACKOFF);
      } else {
        throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
      }
    }
    throw new Error('Failed after ' + retries + ' retries for ' + url);
  }

  function formatTimestamp(date) {
    return date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') + '-' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
  }

  function toUnixTime(createTime) {
    if (!createTime) return 0;
    if (typeof createTime === 'number') return createTime;
    const d = new Date(createTime);
    return isNaN(d.getTime()) ? 0 : d.getTime() / 1000;
  }

  function formatConvDate(createTime) {
    const ts = toUnixTime(createTime);
    if (!ts) return 'unknown';
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return 'unknown';
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
  }

  function safeISODate(createTime) {
    const ts = toUnixTime(createTime);
    if (!ts) return null;
    const d = new Date(ts * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Pure-JS ZIP builder (STORE, no compression).
  function makeZip(entries) {
    const T = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      T[i] = c >>> 0;
    }
    const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const w16 = n => [n & 0xFF, (n >> 8) & 0xFF];
    const w32 = n => { const u = n >>> 0; return [u & 0xFF, (u >> 8) & 0xFF, (u >> 16) & 0xFF, (u >> 24) & 0xFF]; };
    const cat = arrays => { const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0)); let p = 0; for (const a of arrays) { out.set(a, p); p += a.length; } return out; };

    const enc = new TextEncoder();
    const now = new Date();
    const dt = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const tm = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const locals = [], cdirs = [];
    let off = 0;

    for (const e of entries) {
      const name = enc.encode(e.name), data = e.data, crc = crc32(data), sz = data.length;
      const lh = new Uint8Array([0x50,0x4B,0x03,0x04, 0x14,0x00, 0x00,0x00, 0x00,0x00, ...w16(tm),...w16(dt),...w32(crc),...w32(sz),...w32(sz),...w16(name.length),0x00,0x00,...name]);
      const cd = new Uint8Array([0x50,0x4B,0x01,0x02, 0x1E,0x03, 0x14,0x00, 0x00,0x00, 0x00,0x00, ...w16(tm),...w16(dt),...w32(crc),...w32(sz),...w32(sz),...w16(name.length),0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,...w32(off),...name]);
      locals.push(lh, data); cdirs.push(cd); off += lh.length + sz;
    }
    const cdData = cat(cdirs);
    const eocd = new Uint8Array([0x50,0x4B,0x05,0x06, 0x00,0x00,0x00,0x00, ...w16(entries.length),...w16(entries.length),...w32(cdData.length),...w32(off),0x00,0x00]);
    return cat([...locals, cdData, eocd]);
  }

  // ── Main Export ──────────────────────────────────────────

  // Show previously exported progress
  const history = loadHistory();
  if (history.length > 0) {
    log('Previously exported: ' + history.length + ' conversations tracked in localStorage.');
    log('Tip: to clear history run: localStorage.removeItem("' + HISTORY_KEY + '")');
  }

  log('Starting export...');

  // Step 1: Auth
  log('Getting access token...');
  const token = await getAccessToken();
  const accountId = getWorkspaceAccountId();
  const headers = buildHeaders(token, accountId);
  log('Authenticated.' + (accountId ? ' Workspace: ' + accountId : ' Personal account.'));

  // Step 2: List conversations – only fetch the pages needed for the range.
  // The API returns conversations newest-first, so the oldest conversations (the ones
  // we want first) sit at the END of the pagination. We read the total from the first
  // response and jump straight to the relevant pages.
  log('Fetching conversation list...');
  const allMeta = [];

  const firstResp = await fetchWithRetry(
    CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE,
    headers
  );
  const firstData = await firstResp.json();
  const apiTotal  = typeof firstData.total === 'number' ? firstData.total : null;

  const canOptimize = apiTotal !== null && CONFIG.EXPORT_TO > 0;
  let pageEnd = apiTotal || Infinity;

  if (canOptimize) {
    const BUFFER = CONFIG.PAGE_SIZE;
    const pageStart = Math.max(0,
      Math.floor((apiTotal - CONFIG.EXPORT_TO - BUFFER) / CONFIG.PAGE_SIZE) * CONFIG.PAGE_SIZE);
    pageEnd = Math.min(apiTotal,
      Math.ceil((apiTotal - CONFIG.EXPORT_FROM + 1 + BUFFER) / CONFIG.PAGE_SIZE) * CONFIG.PAGE_SIZE);

    const nFetch = Math.ceil((pageEnd - pageStart) / CONFIG.PAGE_SIZE);
    log('Total on server: ' + apiTotal + '. Fetching ' + nFetch + '/' +
        Math.ceil(apiTotal / CONFIG.PAGE_SIZE) + ' page(s) for range ' +
        CONFIG.EXPORT_FROM + '–' + CONFIG.EXPORT_TO);

    for (let o = pageStart; o < pageEnd; o += CONFIG.PAGE_SIZE) {
      if (o === 0) {
        allMeta.push(...firstData.items);
      } else {
        const resp = await fetchWithRetry(
          CONFIG.BASE_URL + '/conversations?offset=' + o + '&limit=' + CONFIG.PAGE_SIZE,
          headers
        );
        const data = await resp.json();
        allMeta.push(...data.items);
        if (data.items.length < CONFIG.PAGE_SIZE) break;
        await sleep(CONFIG.DELAY_BETWEEN_PAGES);
      }
    }
  } else {
    allMeta.push(...firstData.items);
    log('Listed ' + allMeta.length + ' conversations...');
    if (firstData.items.length >= CONFIG.PAGE_SIZE) {
      let offset = CONFIG.PAGE_SIZE;
      while (true) {
        const resp = await fetchWithRetry(
          CONFIG.BASE_URL + '/conversations?offset=' + offset + '&limit=' + CONFIG.PAGE_SIZE,
          headers
        );
        const data = await resp.json();
        allMeta.push(...data.items);
        log('Listed ' + allMeta.length + ' conversations...');
        if (data.items.length < CONFIG.PAGE_SIZE) break;
        offset += CONFIG.PAGE_SIZE;
        await sleep(CONFIG.DELAY_BETWEEN_PAGES);
      }
    }
  }

  // Archived conversations (always fetch first page; usually few)
  log('Checking for archived conversations...');
  const archResp = await fetchWithRetry(
    CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE + '&is_archived=true',
    headers
  );
  const archData = await archResp.json();
  if (archData.items && archData.items.length > 0) {
    allMeta.push(...archData.items);
    log('Found ' + archData.items.length + ' archived conversations.');
  }

  // Step 3: Sort oldest-first and slice to the requested range.
  // When we fetched a subset of pages, allMeta[0] is not position 1 in the full
  // list – it starts at approximately (apiTotal - pageEnd). Adjust indices.
  allMeta.sort((a, b) => toUnixTime(a.create_time) - toUnixTime(b.create_time));
  const serverTotal = apiTotal || allMeta.length;
  const approxStart = canOptimize ? Math.max(0, apiTotal - pageEnd) : 0;
  const fromIdx     = Math.max(0, CONFIG.EXPORT_FROM - 1 - approxStart);
  const toIdx       = CONFIG.EXPORT_TO > 0
                        ? Math.min(allMeta.length, CONFIG.EXPORT_TO - approxStart)
                        : allMeta.length;
  const toExport    = allMeta.slice(fromIdx, toIdx);

  log('Total conversations: ' + serverTotal);
  log('Exporting range: ' + (fromIdx + approxStart + 1) + '–' + (toIdx + approxStart) +
      ' (' + toExport.length + ' conversations)');
  if (toIdx + approxStart < serverTotal) {
    log('Tip: next batch → set EXPORT_FROM: ' + (toIdx + approxStart + 1) +
        ', EXPORT_TO: ' + (toIdx + approxStart + 100));
  }

  // Step 4: Fetch full content of each conversation in the range
  log('Fetching conversation contents...');
  const fullConversations = [];
  const fileAttachments = {};
  const errors = [];
  const exportedIds = [];

  for (let i = 0; i < toExport.length; i++) {
    const conv = toExport[i];
    try {
      const resp = await fetchWithRetry(CONFIG.BASE_URL + '/conversation/' + conv.id, headers);
      const fullData = await resp.json();

      fullConversations.push({
        id: conv.id,
        title: conv.title,
        create_time: conv.create_time,
        update_time: conv.update_time,
        position: fromIdx + i + 1,
        conversation: fullData,
      });

      exportedIds.push(conv.id);

      // Extract file attachment IDs
      if (fullData.mapping) {
        const keys = Object.keys(fullData.mapping);
        for (let k = 0; k < keys.length; k++) {
          const node = fullData.mapping[keys[k]];
          if (node && node.message && node.message.metadata && node.message.metadata.attachments) {
            const atts = node.message.metadata.attachments;
            for (let a = 0; a < atts.length; a++) {
              if (atts[a].id && !fileAttachments[atts[a].id]) {
                fileAttachments[atts[a].id] = {
                  name: atts[a].name || atts[a].id,
                  conversationId: conv.id,
                  conversationTitle: conv.title,
                };
              }
            }
          }
          if (node && node.message && node.message.content && node.message.content.parts) {
            const parts = node.message.content.parts;
            for (let p = 0; p < parts.length; p++) {
              const part = parts[p];
              if (!part || typeof part !== 'object') continue;

              // file-service:// and sediment:// direct asset pointers
              if (part.asset_pointer) {
                const ptr = part.asset_pointer;
                let fid = null, fname = null;
                if (ptr.startsWith('file-service://')) {
                  fid = ptr.replace('file-service://', '');
                  fname = fid;
                } else if (ptr.startsWith('sediment://')) {
                  fid = ptr.replace('sediment://', '');
                  fname = fid + (part.format ? '.' + part.format : '.wav');
                }
                if (fid && !fileAttachments[fid]) {
                  fileAttachments[fid] = { name: fname, conversationId: conv.id, conversationTitle: conv.title };
                }
              }

              // real_time_user_audio_video_asset_pointer: voice input from user
              if (part.content_type === 'real_time_user_audio_video_asset_pointer' &&
                  part.audio_asset_pointer && part.audio_asset_pointer.asset_pointer) {
                const aptr = part.audio_asset_pointer;
                if (aptr.asset_pointer.startsWith('sediment://')) {
                  const fid2 = aptr.asset_pointer.replace('sediment://', '');
                  if (!fileAttachments[fid2]) {
                    fileAttachments[fid2] = {
                      name: fid2 + (aptr.format ? '.' + aptr.format : '.wav'),
                      conversationId: conv.id,
                      conversationTitle: conv.title,
                    };
                  }
                }
              }
            }
          }
        }
      }

      log('(' + (i + 1) + '/' + toExport.length + ') [#' + (fromIdx + i + 1) + '] ' + (conv.title || 'Untitled'));
    } catch (err) {
      log('ERROR: ' + conv.id + ' - ' + err.message);
      errors.push({ id: conv.id, title: conv.title, error: err.message });
      fullConversations.push({ id: conv.id, title: conv.title, error: err.message });
    }

    await sleep(CONFIG.DELAY_BETWEEN_FETCHES);
  }

  // Step 5: Save history, build JSON, bundle into ZIP if attachments requested
  saveHistory(exportedIds);
  const updatedHistory = loadHistory();
  const absTo = toIdx + approxStart;
  log('Progress saved. Total tracked: ' + updatedHistory.length + '/' + serverTotal + ' conversations.');

  log('Building export file...');
  const exportTs  = formatTimestamp(new Date());
  const firstDate = toExport.length > 0 ? formatConvDate(toExport[0].create_time) : 'unknown';
  const lastDate  = toExport.length > 0 ? formatConvDate(toExport[toExport.length - 1].create_time) : 'unknown';
  const baseName  = 'chatgpt-export-' + exportTs + '--' + firstDate + '-to-' + lastDate;
  const fileIds   = Object.keys(fileAttachments);

  const exportData = {
    export_time: new Date().toISOString(),
    source: 'chatgpt-export (github.com/hoya98/chatgpt-export)',
    workspace_account_id: accountId || null,
    export_range: {
      from: fromIdx + approxStart + 1,
      to: absTo,
      total: serverTotal,
      first_conv_date: toExport.length > 0 ? safeISODate(toExport[0].create_time) : null,
      last_conv_date: toExport.length > 0 ? safeISODate(toExport[toExport.length - 1].create_time) : null,
    },
    conversation_count: fullConversations.length,
    attachment_count: fileIds.length,
    errors: errors,
    attachments: fileAttachments,
    conversations: fullConversations,
  };

  const jsonStr   = JSON.stringify(exportData, null, 2);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  log('Conversations: ' + fullConversations.length + ' (~' + Math.round(jsonStr.length / 1024 / 1024) + ' MB JSON)');
  log(fileIds.length + ' attachment references found.');
  if (errors.length > 0) log(errors.length + ' conversations had errors.');

  let outFilename;

  if (fileIds.length > 0) {
    // Fetch all attachments and bundle JSON + files into a single ZIP
    log('Downloading ' + fileIds.length + ' attachments...');
    const zipEntries = [{ name: baseName + '.json', data: jsonBytes }];
    let downloaded = 0, attachErrors = 0;

    for (let f = 0; f < fileIds.length; f++) {
      const fid   = fileIds[f];
      const fname = fileAttachments[fid].name;
      try {
        const fresp = await fetchWithRetry(CONFIG.BASE_URL + '/files/' + fid + '/download', headers);
        const ct = fresp.headers.get('content-type');
        let fileData;
        if (ct && ct.includes('application/json')) {
          const jdata = await fresp.json();
          if (jdata.download_url) {
            const dlResp = await fetch(jdata.download_url);
            fileData = new Uint8Array(await dlResp.arrayBuffer());
          }
        } else {
          fileData = new Uint8Array(await fresp.arrayBuffer());
        }
        if (fileData) { zipEntries.push({ name: 'attachments/' + fname, data: fileData }); downloaded++; }
      } catch (e) { attachErrors++; }
      log('(' + (f + 1) + '/' + fileIds.length + ') ' + fname);
      await sleep(CONFIG.DELAY_BETWEEN_ATTACHMENTS);
    }

    log('Attachments: ' + downloaded + ' OK, ' + attachErrors + ' failed. Building ZIP...');
    const zipData = makeZip(zipEntries);
    outFilename = baseName + '.zip';
    triggerDownload(new Blob([zipData], { type: 'application/zip' }), outFilename);
    log('ZIP: ' + Math.round(zipData.length / 1024 / 1024) + ' MB → ' + outFilename);
  } else {
    outFilename = baseName + '.json';
    triggerDownload(new Blob([jsonStr], { type: 'application/json' }), outFilename);
    log('Downloaded: ' + outFilename);
  }

  if (absTo < serverTotal) {
    log('Next batch: set EXPORT_FROM: ' + (absTo + 1) + ', EXPORT_TO: ' + (absTo + 100));
  } else {
    log('All ' + serverTotal + ' conversations exported!');
  }

  return {
    conversations: fullConversations.length,
    attachments: fileIds.length,
    errors: errors.length,
    filename: outFilename,
    nextFrom: absTo < serverTotal ? absTo + 1 : null,
  };
})();

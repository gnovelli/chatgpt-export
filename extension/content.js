/**
 * ChatGPT Export - Content Script
 * Runs in the context of chatgpt.com pages.
 */

(function () {
  'use strict';

  const CONFIG = {
    BASE_URL: 'https://chatgpt.com/backend-api',
    SESSION_URL: 'https://chatgpt.com/api/auth/session',
    PAGE_SIZE: 100,
    DELAY_FETCHES: 800,
    DELAY_PAGES: 300,
    DELAY_ATTACHMENTS: 500,
    MAX_RETRIES: 5,
    INITIAL_BACKOFF: 500,
    MAX_BACKOFF: 10000,
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sendMsg(type, data) {
    chrome.runtime.sendMessage(Object.assign({ type: type }, data), () => {
      void chrome.runtime.lastError; // suppress "receiving end does not exist" when popup is closed
    });
  }

  function log(msg) {
    sendMsg('export-log', { text: msg });
  }

  async function getAccessToken() {
    const resp = await fetch(CONFIG.SESSION_URL, { credentials: 'include' });
    if (!resp.ok) throw new Error('Not logged in or session expired.');
    const data = await resp.json();
    if (!data.accessToken) throw new Error('No access token found.');
    return data.accessToken;
  }

  function getWorkspaceAccountId() {
    const cookie = document.cookie
      .split(';')
      .find(c => c.trim().startsWith('_account='));
    return cookie ? cookie.split('=')[1].trim() : null;
  }

  function buildHeaders(token, accountId) {
    const h = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (accountId) h['Chatgpt-Account-Id'] = accountId;
    return h;
  }

  async function fetchRetry(url, headers) {
    let delay = CONFIG.INITIAL_BACKOFF;
    for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
      const resp = await fetch(url, { headers: headers, credentials: 'include' });
      if (resp.ok) return resp;
      if (resp.status === 429) {
        const ra = resp.headers.get('retry-after');
        const wait = ra ? parseInt(ra) * 1000 : delay;
        log('Rate limited, waiting ' + wait + 'ms...');
        await sleep(wait);
        delay = Math.min(delay * 2, CONFIG.MAX_BACKOFF);
      } else {
        throw new Error('HTTP ' + resp.status);
      }
    }
    throw new Error('Max retries exceeded');
  }

  function formatTimestamp(date) {
    return date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') + '-' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
  }

  // create_time can be a Unix timestamp (number) or an ISO string depending on account type
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

  // Pure-JS ZIP builder (STORE, no compression). No external dependencies.
  // Each section is written out explicitly so byte counts are easy to verify.
  function makeZip(entries) {
    // CRC-32
    const T = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      T[i] = c >>> 0;
    }
    const crc32 = buf => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };

    // Little-endian helpers — return Uint8Array so concat is type-consistent
    const u16 = n => new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]);
    const u32 = n => { const v = n >>> 0; return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]); };
    const Z2  = new Uint8Array(2);   // 2 zero bytes (reusable; set() copies values)
    const Z4  = new Uint8Array(4);   // 4 zero bytes

    const cat = (...parts) => {
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let pos = 0;
      for (const p of parts) { out.set(p, pos); pos += p.length; }
      return out;
    };

    const enc = new TextEncoder();
    const now = new Date();
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const DT = u16(dosDate);
    const TM = u16(dosTime);

    const locals = [];
    const cdirs  = [];
    let localOff = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.data;
      const CRC  = u32(crc32(data));
      const SZ   = u32(data.length);
      const NL   = u16(name.length);
      const OFF  = u32(localOff);

      // Local file header: 30 bytes fixed + filename
      //   PK\x03\x04  ver=20  flags=0  comp=0  time  date  crc  csize  usize  namelen  extralen  name
      const lh = cat(
        new Uint8Array([0x50,0x4B,0x03,0x04]), u16(20), Z2, Z2,
        TM, DT, CRC, SZ, SZ, NL, Z2,
        name,
      );

      // Central directory entry: 46 bytes fixed + filename
      //   PK\x01\x02  verbymade=0x031E  verneed=20  flags=0  comp=0
      //   time  date  crc  csize  usize  namelen  extralen  commentlen
      //   diskstart  iattr  eattr(4)  localoffset  name
      const cd = cat(
        new Uint8Array([0x50,0x4B,0x01,0x02]),
        new Uint8Array([0x1E,0x03]),  // version made by
        u16(20),                      // version needed
        Z2, Z2,                       // flags, compression
        TM, DT, CRC, SZ, SZ, NL,
        Z2,                           // extra field length
        Z2,                           // file comment length
        Z2,                           // disk number start
        Z2,                           // internal file attributes
        Z4,                           // external file attributes
        OFF,                          // relative offset of local header
        name,
      );

      locals.push(lh, data);
      cdirs.push(cd);
      localOff += lh.length + data.length;
    }

    const cdData = cat(...cdirs);

    // End of central directory: 22 bytes
    const eocd = cat(
      new Uint8Array([0x50,0x4B,0x05,0x06]),
      Z2, Z2,                           // disk number, start disk
      u16(entries.length), u16(entries.length),
      u32(cdData.length), u32(localOff),
      Z2,                               // comment length
    );

    return cat(...locals, cdData, eocd);
  }

  async function runExport(options) {
    try {
      sendMsg('export-status', { text: 'Authenticating...' });

      const token = await getAccessToken();
      const accountId = getWorkspaceAccountId();
      const headers = buildHeaders(token, accountId);
      log('Authenticated.' + (accountId ? ' Workspace detected.' : ' Personal account.'));

      // List conversations – fetch only the pages needed for the requested range.
      //
      // The API returns conversations newest-first. Our range [fromIndex..toIndex]
      // is oldest-first. So the oldest conversation (position 1) sits at the END of
      // the API pagination (high offset). We use the total count returned by the
      // first API response to jump straight to the right pages instead of walking
      // all of them.
      sendMsg('export-status', { text: 'Listing...' });
      const allMeta = [];

      const fromIndex = options.fromIndex || 1;
      const toIndex   = options.toIndex   || 0;   // 0 means "to the end"

      // Always fetch page 0 – it gives us the server-side total count for free.
      const firstResp = await fetchRetry(
        CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE,
        headers
      );
      const firstData = await firstResp.json();
      const apiTotal  = typeof firstData.total === 'number' ? firstData.total : null;

      // Can we skip pages?  Only when both ends of the range are known and the API
      // told us the total.
      const canOptimize = apiTotal !== null && toIndex > 0;

      let pageEnd = apiTotal || Infinity;   // tracks the upper page boundary we fetched up to

      if (canOptimize) {
        // API offset for our 1-based oldest-first position i  =  apiTotal - i
        // Add one page of buffer on each side to absorb the small difference between
        // the API's update-time order and our create-time order.
        const BUFFER = CONFIG.PAGE_SIZE;
        const pageStart = Math.max(0,
          Math.floor((apiTotal - toIndex - BUFFER) / CONFIG.PAGE_SIZE) * CONFIG.PAGE_SIZE);
        pageEnd = Math.min(apiTotal,
          Math.ceil((apiTotal - fromIndex + 1 + BUFFER) / CONFIG.PAGE_SIZE) * CONFIG.PAGE_SIZE);

        const nFetch = Math.ceil((pageEnd - pageStart) / CONFIG.PAGE_SIZE);
        const nTotal = Math.ceil(apiTotal / CONFIG.PAGE_SIZE);
        log('Fetching ' + nFetch + '/' + nTotal + ' page(s) for range ' +
            fromIndex + '–' + toIndex + ' of ' + apiTotal);
        sendMsg('export-stats', { total: apiTotal });

        for (let o = pageStart; o < pageEnd; o += CONFIG.PAGE_SIZE) {
          if (o === 0) {
            allMeta.push(...firstData.items);
          } else {
            const resp = await fetchRetry(
              CONFIG.BASE_URL + '/conversations?offset=' + o + '&limit=' + CONFIG.PAGE_SIZE,
              headers
            );
            const data = await resp.json();
            allMeta.push(...data.items);
            if (data.items.length < CONFIG.PAGE_SIZE) break;
            await sleep(CONFIG.DELAY_PAGES);
          }
        }
      } else {
        // Range not fully specified or total unknown: fetch every page.
        allMeta.push(...firstData.items);
        log('Found ' + allMeta.length + ' conversations...');
        sendMsg('export-stats', { conversations: allMeta.length });

        if (firstData.items.length >= CONFIG.PAGE_SIZE) {
          let offset = CONFIG.PAGE_SIZE;
          while (true) {
            const resp = await fetchRetry(
              CONFIG.BASE_URL + '/conversations?offset=' + offset + '&limit=' + CONFIG.PAGE_SIZE,
              headers
            );
            const data = await resp.json();
            allMeta.push(...data.items);
            log('Found ' + allMeta.length + ' conversations...');
            sendMsg('export-stats', { conversations: allMeta.length });
            if (data.items.length < CONFIG.PAGE_SIZE) break;
            offset += CONFIG.PAGE_SIZE;
            await sleep(CONFIG.DELAY_PAGES);
          }
        }
      }

      // Archived conversations: always fetch the full first page (they are usually
      // few and hard to range-optimise without knowing their total separately).
      if (options.includeArchived) {
        const archResp = await fetchRetry(
          CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE + '&is_archived=true',
          headers
        );
        const archData = await archResp.json();
        if (archData.items && archData.items.length > 0) {
          allMeta.push(...archData.items);
          log('Added ' + archData.items.length + ' archived conversations.');
        }
      }

      // Sort oldest-first.
      allMeta.sort(function (a, b) { return toUnixTime(a.create_time) - toUnixTime(b.create_time); });

      // When we fetched only a subset of pages, allMeta[0] is NOT position 1 in the
      // full sorted list – it starts at approximately (apiTotal - pageEnd).
      // Adjust the slice indices accordingly.
      const serverTotal   = apiTotal || allMeta.length;
      const approxStart   = canOptimize ? Math.max(0, apiTotal - pageEnd) : 0;
      const fromIdx       = Math.max(0, fromIndex - 1 - approxStart);
      const toIdx         = toIndex > 0
                              ? Math.min(allMeta.length, toIndex - approxStart)
                              : allMeta.length;
      const toExport      = allMeta.slice(fromIdx, toIdx);

      log('Exporting ' + (fromIdx + approxStart + 1) + '–' + (toIdx + approxStart) +
          ' of ' + serverTotal + ' (' + toExport.length + ' conversations)');
      sendMsg('export-stats', { conversations: toExport.length, total: serverTotal });

      // Fetch each conversation in range
      sendMsg('export-status', { text: 'Downloading...' });
      const conversations = [];
      const fileAttachments = {};
      const errors = [];
      const exportedIds = [];

      for (let i = 0; i < toExport.length; i++) {
        const c = toExport[i];
        try {
          const resp = await fetchRetry(CONFIG.BASE_URL + '/conversation/' + c.id, headers);
          const full = await resp.json();
          conversations.push({
            id: c.id,
            title: c.title,
            create_time: c.create_time,
            update_time: c.update_time,
            position: fromIdx + i + 1,
            conversation: full,
          });

          exportedIds.push(c.id);

          // Extract attachment IDs
          if (full.mapping) {
            Object.keys(full.mapping).forEach(function (key) {
              var node = full.mapping[key];
              if (node && node.message && node.message.metadata && node.message.metadata.attachments) {
                node.message.metadata.attachments.forEach(function (att) {
                  if (att.id && !fileAttachments[att.id]) {
                    fileAttachments[att.id] = { name: att.name || att.id, conversationId: c.id };
                  }
                });
              }
              if (node && node.message && node.message.content && node.message.content.parts) {
                node.message.content.parts.forEach(function (part) {
                  if (!part || typeof part !== 'object') return;

                  // file-service:// and sediment:// direct asset pointers
                  if (part.asset_pointer) {
                    var ptr = part.asset_pointer;
                    var fid = null;
                    var fname = null;
                    if (ptr.startsWith('file-service://')) {
                      fid = ptr.replace('file-service://', '');
                      fname = fid;
                    } else if (ptr.startsWith('sediment://')) {
                      fid = ptr.replace('sediment://', '');
                      fname = fid + (part.format ? '.' + part.format : '.wav');
                    }
                    if (fid && !fileAttachments[fid]) {
                      fileAttachments[fid] = { name: fname, conversationId: c.id };
                    }
                  }

                  // real_time_user_audio_video_asset_pointer: voice input from user
                  if (part.content_type === 'real_time_user_audio_video_asset_pointer' &&
                      part.audio_asset_pointer && part.audio_asset_pointer.asset_pointer) {
                    var aptr = part.audio_asset_pointer;
                    if (aptr.asset_pointer.startsWith('sediment://')) {
                      var fid2 = aptr.asset_pointer.replace('sediment://', '');
                      if (!fileAttachments[fid2]) {
                        fileAttachments[fid2] = {
                          name: fid2 + (aptr.format ? '.' + aptr.format : '.wav'),
                          conversationId: c.id,
                        };
                      }
                    }
                  }
                });
              }
            });
          }

          sendMsg('export-progress', { current: i + 1, total: toExport.length });
          sendMsg('export-stats', { attachments: Object.keys(fileAttachments).length });
        } catch (err) {
          errors.push({ id: c.id, title: c.title, error: err.message });
          conversations.push({ id: c.id, title: c.title, error: err.message });
          log('Error: ' + (c.title || c.id) + ' - ' + err.message);
          sendMsg('export-progress', { current: i + 1, total: toExport.length });
        }

        await sleep(CONFIG.DELAY_FETCHES);
      }

      // Build export JSON
      sendMsg('export-status', { text: 'Packaging...' });
      log('Building export file...');

      var firstConvDate = toExport.length > 0 ? formatConvDate(toExport[0].create_time) : 'unknown';
      var lastConvDate  = toExport.length > 0 ? formatConvDate(toExport[toExport.length - 1].create_time) : 'unknown';
      var exportTs  = formatTimestamp(new Date());
      var baseName  = 'chatgpt-export-' + exportTs + '--' + firstConvDate + '-to-' + lastConvDate;

      var fileIds   = Object.keys(fileAttachments);

      var exportData = {
        export_time: new Date().toISOString(),
        source: 'chatgpt-export (github.com/hoya98/chatgpt-export)',
        workspace_account_id: accountId || null,
        export_range: {
          from: fromIdx + approxStart + 1,
          to: toIdx + approxStart,
          total: serverTotal,
          first_conv_date: toExport.length > 0 ? safeISODate(toExport[0].create_time) : null,
          last_conv_date: toExport.length > 0 ? safeISODate(toExport[toExport.length - 1].create_time) : null,
        },
        conversation_count: conversations.length,
        attachment_count: fileIds.length,
        errors: errors,
        attachments: fileAttachments,
        conversations: conversations,
      };

      var jsonStr   = JSON.stringify(exportData, null, 2);
      var jsonBytes = new TextEncoder().encode(jsonStr);
      log('Conversations: ' + conversations.length + ' (~' + Math.round(jsonStr.length / 1024 / 1024) + ' MB JSON)');

      log('Attachments found: ' + fileIds.length);
      sendMsg('export-status', { text: fileIds.length + ' attachments found' });
      sendMsg('export-stats', { attachments: fileIds.length });

      if (options.includeAttachments) {
        // When the checkbox is active, always produce a ZIP — even if no
        // attachments were found (ZIP will contain only the JSON in that case).
        var zipEntries = [{ name: baseName + '.json', data: jsonBytes }];
        var downloaded = 0;
        var attachErrors = 0;

        if (fileIds.length > 0) {
          sendMsg('export-status', { text: 'Downloading attachments...' });
          for (var f = 0; f < fileIds.length; f++) {
            var fid   = fileIds[f];
            var fname = fileAttachments[fid].name;
            var fileData;
            try {
              var fresp = await fetchRetry(CONFIG.BASE_URL + '/files/' + fid + '/download', headers);
              var ct = fresp.headers.get('content-type') || '';
              log('  [' + fid.slice(0,12) + '…] HTTP ' + fresp.status + ' ct=' + ct.split(';')[0]);
              if (ct.includes('application/json')) {
                var jdata = await fresp.json();
                if (jdata.download_url) {
                  var dlResp = await fetch(jdata.download_url);
                  log('    redirect HTTP ' + dlResp.status);
                  fileData = new Uint8Array(await dlResp.arrayBuffer());
                } else {
                  log('    no download_url in response: ' + JSON.stringify(jdata).slice(0,120));
                }
              } else {
                fileData = new Uint8Array(await fresp.arrayBuffer());
              }
              if (fileData && fileData.length > 0) {
                zipEntries.push({ name: 'attachments/' + fname, data: fileData });
                downloaded++;
                log('  ✓ ' + fname + ' (' + Math.round(fileData.length / 1024) + ' KB)');
              } else {
                log('  ✗ ' + fname + ': empty response');
                attachErrors++;
              }
            } catch (e) {
              log('  ✗ ' + fname + ': ' + e.message);
              attachErrors++;
            }
            sendMsg('export-progress', { current: f + 1, total: fileIds.length });
            await sleep(CONFIG.DELAY_ATTACHMENTS);
          }
          log('Attachments: ' + downloaded + ' OK, ' + attachErrors + ' failed.');
        }

        sendMsg('export-status', { text: 'Building ZIP...' });
        var zipData = makeZip(zipEntries);
        triggerDownload(new Blob([zipData], { type: 'application/zip' }), baseName + '.zip');
        log('ZIP: ' + Math.round(zipData.length / 1024 / 1024) + ' MB → ' + baseName + '.zip');
      } else {
        // Checkbox not active: plain JSON only
        triggerDownload(new Blob([jsonStr], { type: 'application/json' }), baseName + '.json');
        log('Downloaded: ' + baseName + '.json');
      }

      var absTo = toIdx + approxStart;

      // Send exported IDs back to popup for persistent storage
      sendMsg('export-ids', {
        ids: exportedIds,
        total: serverTotal,
        nextFrom: absTo < serverTotal ? absTo + 1 : null,
      });

      sendMsg('export-done', {
        conversations: conversations.length,
        attachments: Object.keys(fileAttachments).length,
        nextFrom: absTo < serverTotal ? absTo + 1 : null,
        total: serverTotal,
      });

    } catch (err) {
      sendMsg('export-error', { text: err.message });
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.action === 'startExport') {
      runExport(msg.options || {});
    }
  });
})();

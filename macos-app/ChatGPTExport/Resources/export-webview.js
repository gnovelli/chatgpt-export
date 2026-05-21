/**
 * ChatGPT Export - WebView Export Script
 *
 * Adapted from the Chrome extension content script for use in a native
 * macOS WKWebView. Communicates progress back to Swift via
 * webkit.messageHandlers.<name>.postMessage({...})
 *
 * Options are passed via window.__EXPORT_OPTIONS before this script runs.
 */

(async function ChatGPTWebViewExport() {
  'use strict';

  var options = window.__EXPORT_OPTIONS || {};
  var includeArchived = options.includeArchived !== false;
  var includeAttachments = options.includeAttachments !== false;

  var CONFIG = {
    BASE_URL: 'https://chatgpt.com/backend-api',
    SESSION_URL: 'https://chatgpt.com/api/auth/session',
    PAGE_SIZE: 100,
    DELAY_FETCHES: 800,
    DELAY_PAGES: 300,
    DELAY_ATTACHMENTS: 500,
    MAX_RETRIES: 5,
    INITIAL_BACKOFF: 500,
    MAX_BACKOFF: 10000
  };

  // ── Message helpers (Swift bridge) ─────────────────────────

  function sendLog(msg, isError) {
    try {
      webkit.messageHandlers.exportLog.postMessage({
        text: msg,
        isError: isError || false
      });
    } catch (e) {
      console.log('[ChatGPT Export] ' + msg);
    }
  }

  function sendStatus(status, extra) {
    try {
      var payload = { status: status };
      if (extra) {
        var keys = Object.keys(extra);
        for (var i = 0; i < keys.length; i++) {
          payload[keys[i]] = extra[keys[i]];
        }
      }
      webkit.messageHandlers.exportStatus.postMessage(payload);
    } catch (e) {
      console.log('[ChatGPT Export] Status: ' + status);
    }
  }

  function sendProgress(current, total) {
    try {
      webkit.messageHandlers.exportProgress.postMessage({
        current: current,
        total: total
      });
    } catch (e) {}
  }

  function sendStats(data) {
    try {
      webkit.messageHandlers.exportStats.postMessage(data);
    } catch (e) {}
  }

  function sendDone(data) {
    try {
      webkit.messageHandlers.exportDone.postMessage(data);
    } catch (e) {}
  }

  function sendError(msg) {
    try {
      webkit.messageHandlers.exportError.postMessage({ text: msg });
    } catch (e) {
      console.error('[ChatGPT Export] Error: ' + msg);
    }
  }

  function sendExportData(jsonStr) {
    try {
      webkit.messageHandlers.exportData.postMessage({ data: jsonStr });
    } catch (e) {
      console.error('[ChatGPT Export] Failed to send export data');
    }
  }

  // ── Utilities ──────────────────────────────────────────────

  function formatTimestamp(date) {
    return date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') + '-' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
  }

  function formatConvDate(unixSeconds) {
    if (!unixSeconds) return 'unknown';
    var d = new Date(unixSeconds * 1000);
    if (isNaN(d.getTime())) return 'unknown';
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
  }

  function safeISODate(unixSeconds) {
    if (!unixSeconds) return null;
    var d = new Date(unixSeconds * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function getAccessToken() {
    var resp = await fetch(CONFIG.SESSION_URL, { credentials: 'include' });
    if (!resp.ok) throw new Error('Not logged in or session expired.');
    var data = await resp.json();
    if (!data.accessToken) throw new Error('No access token found.');
    return data.accessToken;
  }

  function getWorkspaceAccountId() {
    var cookie = document.cookie
      .split(';')
      .find(function (c) {
        return c.trim().startsWith('_account=');
      });
    return cookie ? cookie.split('=')[1].trim() : null;
  }

  function buildHeaders(token, accountId) {
    var h = {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    };
    if (accountId) {
      h['Chatgpt-Account-Id'] = accountId;
    }
    return h;
  }

  async function fetchRetry(url, headers) {
    var delay = CONFIG.INITIAL_BACKOFF;
    for (var i = 0; i < CONFIG.MAX_RETRIES; i++) {
      var resp = await fetch(url, { headers: headers, credentials: 'include' });
      if (resp.ok) return resp;
      if (resp.status === 429) {
        var ra = resp.headers.get('retry-after');
        var wait = ra ? parseInt(ra) * 1000 : delay;
        sendLog('Rate limited, waiting ' + wait + 'ms (retry ' + (i + 1) + '/' + CONFIG.MAX_RETRIES + ')');
        await sleep(wait);
        delay = Math.min(delay * 2, CONFIG.MAX_BACKOFF);
      } else {
        throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
      }
    }
    throw new Error('Max retries exceeded for ' + url);
  }

  // ── Main Export ────────────────────────────────────────────

  try {
    // Step 1: Auth
    sendStatus('authenticating');
    sendLog('Getting access token...');

    var token = await getAccessToken();
    var accountId = getWorkspaceAccountId();
    var headers = buildHeaders(token, accountId);

    sendLog('Authenticated.' + (accountId ? ' Workspace: ' + accountId : ' Personal account.'));

    // Step 2: List conversations – only fetch the pages needed for the range.
    // The API returns conversations newest-first; oldest conversations are at the
    // end of pagination. We read the total from the first response and jump to the
    // relevant pages. For the macOS app there is no range yet (fromIndex/toIndex
    // come from options and default to 0 = all), so canOptimize is false and we
    // fall back to fetching all pages.
    sendStatus('listing');
    sendLog('Fetching conversation list...');

    var allMeta = [];
    var fromIndex = (options && options.fromIndex) ? options.fromIndex : 1;
    var toIndex   = (options && options.toIndex)   ? options.toIndex   : 0;

    var firstListResp = await fetchRetry(
      CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE,
      headers
    );
    var firstListData = await firstListResp.json();
    var apiTotal = typeof firstListData.total === 'number' ? firstListData.total : null;

    var canOptimize = apiTotal !== null && toIndex > 0;
    var pageEnd = apiTotal || Infinity;

    if (canOptimize) {
      var BUFFER = CONFIG.PAGE_SIZE;
      var pageStart = Math.max(0,
        Math.floor((apiTotal - toIndex - BUFFER) / CONFIG.PAGE_SIZE) * CONFIG.PAGE_SIZE);
      pageEnd = Math.min(apiTotal,
        Math.ceil((apiTotal - fromIndex + 1 + BUFFER) / CONFIG.PAGE_SIZE) * CONFIG.PAGE_SIZE);

      var nFetch = Math.ceil((pageEnd - pageStart) / CONFIG.PAGE_SIZE);
      sendLog('Total on server: ' + apiTotal + '. Fetching ' + nFetch + '/' +
              Math.ceil(apiTotal / CONFIG.PAGE_SIZE) + ' page(s) for range ' +
              fromIndex + '–' + toIndex);
      sendStats({ conversations: toIndex - fromIndex + 1, total: apiTotal });

      for (var o = pageStart; o < pageEnd; o += CONFIG.PAGE_SIZE) {
        if (o === 0) {
          allMeta = allMeta.concat(firstListData.items);
        } else {
          var pr = await fetchRetry(
            CONFIG.BASE_URL + '/conversations?offset=' + o + '&limit=' + CONFIG.PAGE_SIZE,
            headers
          );
          var pd = await pr.json();
          allMeta = allMeta.concat(pd.items);
          if (pd.items.length < CONFIG.PAGE_SIZE) break;
          await sleep(CONFIG.DELAY_PAGES);
        }
      }
    } else {
      allMeta = allMeta.concat(firstListData.items);
      sendLog('Found ' + allMeta.length + ' conversations...');
      sendStats({ conversations: allMeta.length });

      if (firstListData.items.length >= CONFIG.PAGE_SIZE) {
        var offset = CONFIG.PAGE_SIZE;
        while (true) {
          var listResp = await fetchRetry(
            CONFIG.BASE_URL + '/conversations?offset=' + offset + '&limit=' + CONFIG.PAGE_SIZE,
            headers
          );
          var listData = await listResp.json();
          allMeta = allMeta.concat(listData.items);
          sendLog('Found ' + allMeta.length + ' conversations...');
          sendStats({ conversations: allMeta.length });
          if (listData.items.length < CONFIG.PAGE_SIZE) break;
          offset += CONFIG.PAGE_SIZE;
          await sleep(CONFIG.DELAY_PAGES);
        }
      }
    }

    // Archived conversations (paginate fully since they can't be range-optimised
    // without a separate total count from the archived endpoint)
    if (includeArchived) {
      sendLog('Checking archived conversations...');
      var archUrl = CONFIG.BASE_URL + '/conversations?offset=0&limit=' + CONFIG.PAGE_SIZE + '&is_archived=true';
      var archResp = await fetchRetry(archUrl, headers);
      var archData = await archResp.json();

      if (archData.items && archData.items.length > 0) {
        allMeta = allMeta.concat(archData.items);
        sendLog('Added ' + archData.items.length + ' archived conversations.');
        sendStats({ conversations: allMeta.length });

        var archOffset = CONFIG.PAGE_SIZE;
        while (archData.items.length >= CONFIG.PAGE_SIZE) {
          archUrl = CONFIG.BASE_URL + '/conversations?offset=' + archOffset + '&limit=' + CONFIG.PAGE_SIZE + '&is_archived=true';
          archResp = await fetchRetry(archUrl, headers);
          archData = await archResp.json();
          if (archData.items && archData.items.length > 0) {
            allMeta = allMeta.concat(archData.items);
            sendLog('Added ' + archData.items.length + ' more archived conversations.');
            sendStats({ conversations: allMeta.length });
          }
          archOffset += CONFIG.PAGE_SIZE;
          await sleep(CONFIG.DELAY_PAGES);
        }
      }
    }

    // Sort oldest-first and apply range (with offset adjustment for partial fetches)
    allMeta.sort(function(a, b) { return (a.create_time || 0) - (b.create_time || 0); });
    var serverTotal  = apiTotal || allMeta.length;
    var approxStart  = canOptimize ? Math.max(0, apiTotal - pageEnd) : 0;
    var sliceFrom    = Math.max(0, fromIndex - 1 - approxStart);
    var sliceTo      = toIndex > 0 ? Math.min(allMeta.length, toIndex - approxStart) : allMeta.length;
    allMeta          = allMeta.slice(sliceFrom, sliceTo);

    sendLog('Total: ' + serverTotal + ' conversations. Exporting ' + allMeta.length + '.');

    // Step 3: Fetch each conversation
    sendStatus('downloading', { current: 0, total: allMeta.length });
    sendLog('Downloading conversation contents...');

    var conversations = [];
    var fileAttachments = {};
    var errors = [];

    for (var i = 0; i < allMeta.length; i++) {
      var c = allMeta[i];
      try {
        var convUrl = CONFIG.BASE_URL + '/conversation/' + c.id;
        var convResp = await fetchRetry(convUrl, headers);
        var full = await convResp.json();

        conversations.push({
          id: c.id,
          title: c.title,
          create_time: c.create_time,
          update_time: c.update_time,
          conversation: full
        });

        // Extract attachment references
        if (full.mapping) {
          var nodeKeys = Object.keys(full.mapping);
          for (var k = 0; k < nodeKeys.length; k++) {
            var node = full.mapping[nodeKeys[k]];

            // Check metadata attachments
            if (node && node.message && node.message.metadata && node.message.metadata.attachments) {
              var atts = node.message.metadata.attachments;
              for (var a = 0; a < atts.length; a++) {
                if (atts[a].id && !fileAttachments[atts[a].id]) {
                  fileAttachments[atts[a].id] = {
                    name: atts[a].name || atts[a].id,
                    conversationId: c.id,
                    conversationTitle: c.title
                  };
                }
              }
            }

            // Check content parts for file-service:// references
            if (node && node.message && node.message.content && node.message.content.parts) {
              var parts = node.message.content.parts;
              for (var p = 0; p < parts.length; p++) {
                if (parts[p] && typeof parts[p] === 'object' && parts[p].asset_pointer) {
                  var ptr = parts[p].asset_pointer;
                  if (ptr.startsWith('file-service://')) {
                    var fid = ptr.replace('file-service://', '');
                    if (!fileAttachments[fid]) {
                      fileAttachments[fid] = {
                        name: fid,
                        conversationId: c.id,
                        conversationTitle: c.title
                      };
                    }
                  }
                }
              }
            }
          }
        }

        sendStats({
          currentTitle: c.title || 'Untitled',
          attachments: Object.keys(fileAttachments).length
        });
        sendLog('(' + (i + 1) + '/' + allMeta.length + ') ' + (c.title || 'Untitled'));

      } catch (err) {
        errors.push({ id: c.id, title: c.title, error: err.message });
        conversations.push({ id: c.id, title: c.title, error: err.message });
        sendLog('Error: ' + (c.title || c.id) + ' - ' + err.message, true);
        sendStats({ errors: errors.length });
      }

      sendProgress(i + 1, allMeta.length);
      await sleep(CONFIG.DELAY_FETCHES);
    }

    // Step 4: Build export
    sendStatus('packaging');
    sendLog('Building export file...');

    var firstConvDate = allMeta.length > 0 ? formatConvDate(allMeta[0].create_time) : 'unknown';
    var lastConvDate  = allMeta.length > 0 ? formatConvDate(allMeta[allMeta.length - 1].create_time) : 'unknown';
    var exportTs = formatTimestamp(new Date());
    var suggestedFilename = 'chatgpt-export-' + exportTs + '--' + firstConvDate + '-to-' + lastConvDate + '.json';

    var exportData = {
      export_time: new Date().toISOString(),
      source: 'ChatGPT Export macOS App',
      workspace_account_id: accountId || null,
      export_range: {
        total: allMeta.length,
        first_conv_date: allMeta.length > 0 ? safeISODate(allMeta[0].create_time) : null,
        last_conv_date: allMeta.length > 0 ? safeISODate(allMeta[allMeta.length - 1].create_time) : null,
      },
      conversation_count: conversations.length,
      attachment_count: Object.keys(fileAttachments).length,
      errors: errors,
      attachments: fileAttachments,
      conversations: conversations
    };

    var jsonStr = JSON.stringify(exportData, null, 2);
    var sizeMB = Math.round(jsonStr.length / 1024 / 1024);

    sendLog('Export ready: ' + conversations.length + ' conversations (~' + sizeMB + ' MB)');
    sendLog(Object.keys(fileAttachments).length + ' attachment references found.');

    if (errors.length > 0) {
      sendLog(errors.length + ' conversations had errors.');
    }

    // Send the data to Swift for saving via NSSavePanel
    sendExportData(jsonStr);

    // Signal completion (includes suggested filename for NSSavePanel default)
    sendDone({
      conversations: conversations.length,
      attachments: Object.keys(fileAttachments).length,
      errors: errors.length,
      sizeMB: sizeMB,
      suggestedFilename: suggestedFilename
    });

  } catch (err) {
    sendError(err.message || 'Unknown error during export');
    sendLog('Fatal error: ' + err.message, true);
  }
})();
